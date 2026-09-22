import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import type { ProjectFileRecord, ProjectRecord } from "../projectStore.js";
import { ProjectFileIntegrationService } from "./projectFileIntegration.js";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import { UploadSessionService } from "./uploadSessionService.js";
import type { UploadSessionRecord } from "./uploadSessionTypes.js";

const temporaryDirectories: string[] = [];
const silentLogger = { info: (_message: string) => undefined, error: (_message: string) => undefined };

afterEach(() => {
    while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-upload-integration-"));
    temporaryDirectories.push(root);
    const repository = new UploadSessionRepository(path.join(root, "upload-sessions"));
    const project: ProjectRecord = {
        id: "project-1",
        name: "Integration test",
        description: "",
        createdAt: "2026-09-22T10:00:00.000Z",
        updatedAt: "2026-09-22T10:00:00.000Z",
        files: [],
    };
    const service = new UploadSessionService(repository, (id) => id === project.id, {
        chunkSize: 4,
        getFreeDiskBytes: () => Number.MAX_SAFE_INTEGER,
        logger: silentLogger,
        idFactory: (() => {
            let index = 0;
            return () => [
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
            ][index++] ?? "33333333-3333-4333-8333-333333333333";
        })(),
    });
    const dispatches: string[] = [];
    const dispatched = new Set<string>();
    const integration = new ProjectFileIntegrationService({
        repository,
        getProject: (id) => id === project.id ? project : undefined,
        updateProject: (id, update) => {
            if (id !== project.id) return undefined;
            update(project);
            return project;
        },
        getProjectDirectory: (id) => path.join(root, "projects", id),
        createProjectFileRecord: (_storedProject, session) => ({
            id: session.reservedFileId,
            revision: 1,
            originalName: session.filename,
            kind: session.fileKind === "ifc" ? "ifc" : session.fileKind === "structured-e57" ? "structured-e57" : "point-cloud",
            status: session.fileKind === "point-cloud" ? "ready" : "queued",
        }),
        dispatchProjectFileProcessing: (_projectId, file, inputPath) => {
            if ((file.status !== "queued" && file.status !== "processing") || dispatched.has(file.id)) return false;
            assert.ok(fs.existsSync(inputPath));
            dispatched.add(file.id);
            dispatches.push(file.id);
            return true;
        },
        logger: silentLogger,
    });
    return { root, repository, service, project, integration, dispatches, dispatched };
}

async function finalizedSession(service: UploadSessionService, bytes: Buffer, fileKind: "ifc" | "structured-e57" = "structured-e57"): Promise<UploadSessionRecord> {
    const session = service.createSession({
        projectId: "project-1",
        filename: fileKind === "ifc" ? "building.ifc" : "survey.e57",
        fileKind,
        totalBytes: bytes.length,
        mimeType: "application/octet-stream",
        expectedSha256: sha256(bytes),
    }).session;
    for (let partNumber = 0; partNumber < session.totalParts; partNumber += 1) {
        const part = bytes.subarray(partNumber * session.chunkSize, Math.min(bytes.length, (partNumber + 1) * session.chunkSize));
        await service.uploadPart({
            uploadId: session.uploadId,
            partNumber,
            contentLength: String(part.length),
            contentType: "application/octet-stream",
            expectedSha256: sha256(part),
            body: Readable.from([part]),
        });
    }
    await service.completeSession(session.uploadId);
    return service.waitForFinalization(session.uploadId);
}

test("adopts a finalized resumable E57 into one canonical project file and dispatches the existing processor", async () => {
    const { root, repository, service, project, integration, dispatches } = fixture();
    const bytes = Buffer.from("resumable-e57-source");
    const session = await finalizedSession(service, bytes);

    await integration.ensure(session.uploadId);
    const registered = repository.get(session.uploadId)!;
    const sourcePath = path.join(root, "projects", project.id, "uploads", `${session.reservedFileId}.e57`);

    assert.equal(project.files.length, 1);
    assert.equal(project.files[0]?.id, session.reservedFileId);
    assert.equal(project.files[0]?.kind, "structured-e57");
    assert.equal(project.files[0]?.status, "queued");
    assert.equal(registered.projectFileId, session.reservedFileId);
    assert.ok(registered.registeredAt);
    assert.ok(registered.processingStartedAt);
    assert.deepEqual(fs.readFileSync(sourcePath), bytes);
    assert.equal(fs.existsSync(repository.getFinalizedArtifactPath(session)), false);
    assert.deepEqual(dispatches, [session.reservedFileId]);

    await integration.ensure(session.uploadId);
    assert.equal(project.files.length, 1);
    assert.deepEqual(dispatches, [session.reservedFileId]);
    assert.equal(repository.get(session.uploadId)?.integrationStage, "dispatched");

    // Older status polls could regress this marker while preserving the
    // authoritative processingStartedAt timestamp. Recovery repairs it.
    const regressed = repository.get(session.uploadId)!;
    repository.save({ ...regressed, integrationStage: "registered" });
    await integration.ensure(session.uploadId, true);
    assert.equal(repository.get(session.uploadId)?.integrationStage, "dispatched");
});

test("reconciles a crash after atomic move but before ProjectFileRecord persistence", async () => {
    const { root, repository, service, project, integration, dispatches } = fixture();
    const bytes = Buffer.from("ifc-source");
    const session = await finalizedSession(service, bytes, "ifc");
    const destination = path.join(root, "projects", project.id, "uploads", `${session.reservedFileId}.ifc`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(repository.getFinalizedArtifactPath(session), destination);

    await integration.ensure(session.uploadId, true);

    assert.equal(project.files.length, 1);
    assert.equal(project.files[0]?.id, session.reservedFileId);
    assert.deepEqual(fs.readFileSync(destination), bytes);
    assert.deepEqual(dispatches, [session.reservedFileId]);
});

test("rejects a same-size but corrupted canonical source in the unregistered crash window", async () => {
    const { root, repository, service, project, integration } = fixture();
    const bytes = Buffer.from("ifc-source");
    const session = await finalizedSession(service, bytes, "ifc");
    const destination = path.join(root, "projects", project.id, "uploads", `${session.reservedFileId}.ifc`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(repository.getFinalizedArtifactPath(session), destination);
    fs.writeFileSync(destination, Buffer.from("bad-source"));

    await integration.ensure(session.uploadId, true);

    assert.equal(project.files.length, 0);
    assert.equal(repository.get(session.uploadId)?.integrationError?.stage, "adopt");
});

test("re-dispatches a processing file after restart without creating another project record", async () => {
    const { repository, service, project, integration, dispatches, dispatched } = fixture();
    const session = await finalizedSession(service, Buffer.from("e57-source"));
    await integration.ensure(session.uploadId);
    project.files[0]!.status = "processing";
    dispatched.clear(); // In-memory controller state is lost when the server restarts.

    await integration.ensure(session.uploadId, true);

    assert.equal(project.files.length, 1);
    assert.deepEqual(dispatches, [session.reservedFileId, session.reservedFileId]);
    assert.equal(repository.get(session.uploadId)?.integrationStage, "dispatched");
});

test("reconciles a persisted project record when the session manifest missed registration", async () => {
    const { root, repository, service, project, integration, dispatches } = fixture();
    const bytes = Buffer.from("ifc-source");
    const session = await finalizedSession(service, bytes, "ifc");
    const destination = path.join(root, "projects", project.id, "uploads", `${session.reservedFileId}.ifc`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(repository.getFinalizedArtifactPath(session), destination);
    project.files.push({
        id: session.reservedFileId,
        revision: 1,
        originalName: session.filename,
        kind: "ifc",
        status: "queued",
    });

    await integration.ensure(session.uploadId, true);

    assert.equal(project.files.length, 1);
    assert.equal(repository.get(session.uploadId)?.projectFileId, session.reservedFileId);
    assert.deepEqual(dispatches, [session.reservedFileId]);
});

test("does not register an upload when its finalized artifact is missing", async () => {
    const { repository, service, project, integration } = fixture();
    const session = await finalizedSession(service, Buffer.from("missing-artifact"));
    fs.rmSync(repository.getFinalizedArtifactPath(session), { force: true });

    await integration.ensure(session.uploadId);

    const persisted = repository.get(session.uploadId)!;
    assert.equal(project.files.length, 0);
    assert.equal(persisted.status, "complete");
    assert.equal(persisted.integrationError?.stage, "adopt");
});

test("never registers a non-finalized transport session", async () => {
    const { repository, service, project, integration } = fixture();
    const session = service.createSession({
        projectId: "project-1",
        filename: "still-uploading.e57",
        fileKind: "structured-e57",
        totalBytes: 4,
        mimeType: "application/octet-stream",
    }).session;

    await integration.ensure(session.uploadId);

    assert.equal(project.files.length, 0);
    assert.equal(repository.get(session.uploadId)?.status, "created");
});
