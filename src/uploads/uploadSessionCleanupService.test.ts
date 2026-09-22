import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, test } from "node:test";
import type { ProjectRecord } from "../projectStore.js";
import { UploadSessionCleanupService } from "./uploadSessionCleanupService.js";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import { UploadSessionService } from "./uploadSessionService.js";
import type { UploadSessionRecord } from "./uploadSessionTypes.js";

const roots: string[] = [];
const silent = { info: (_message: string) => undefined, warn: (_message: string) => undefined,
    error: (_message: string) => undefined };
afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-upload-cleanup-"));
    roots.push(root);
    let time = new Date("2026-09-22T10:00:00.000Z");
    const repository = new UploadSessionRepository(path.join(root, "upload-sessions"));
    const project: ProjectRecord = {
        id: randomUUID(), name: "Cleanup fixture", description: "", files: [],
        createdAt: time.toISOString(), updatedAt: time.toISOString(),
    };
    const makeService = () => new UploadSessionService(repository, (id) => id === project.id, {
        chunkSize: 4, now: () => time, logger: silent,
        getFreeDiskBytes: () => Number.MAX_SAFE_INTEGER,
    });
    const service = makeService();
    const makeCleanup = (sessions = service) => new UploadSessionCleanupService({
        repository, sessions, now: () => time, logger: silent,
        getProject: (id) => id === project.id ? project : undefined,
        getProjectDirectory: (id) => path.join(root, "projects", id),
    });
    const advanceDays = (days: number) => { time = new Date(time.getTime() + days * 24 * 60 * 60 * 1000); };
    const create = (kind: "structured-e57" | "ifc" = "structured-e57") => service.createSession({
        projectId: project.id, filename: kind === "ifc" ? "model.ifc" : "scan.e57",
        fileKind: kind, totalBytes: 8,
    }).session;
    const addPart = (session: UploadSessionRecord, partNumber: number) => service.uploadPart({
        uploadId: session.uploadId, partNumber, contentLength: "4",
        contentType: "application/octet-stream", body: Readable.from([Buffer.from("abcd")]),
    });
    const finalize = async (session: UploadSessionRecord) => {
        await addPart(session, 0);
        await addPart(session, 1);
        await service.completeSession(session.uploadId);
        return service.waitForFinalization(session.uploadId);
    };
    const register = (session: UploadSessionRecord) => {
        const canonicalDirectory = path.join(root, "projects", project.id, "uploads");
        fs.mkdirSync(canonicalDirectory, { recursive: true });
        const source = path.join(canonicalDirectory, `${session.reservedFileId}${session.normalizedExtension}`);
        fs.renameSync(repository.getFinalizedArtifactPath(session), source);
        project.files.push({ id: session.reservedFileId, originalName: session.filename,
            kind: session.fileKind, status: "ready", revision: 1 });
        repository.save({ ...session, projectFileId: session.reservedFileId,
            integrationStage: "dispatched", registeredAt: time.toISOString(),
            processingStartedAt: time.toISOString() });
        return source;
    };
    return { root, repository, project, service, makeService, makeCleanup, advanceDays,
        create, addPart, finalize, register };
}

test("created and uploading sessions expire after 72 hours, keep tombstones, and reject resume/finalize", async () => {
    const f = fixture();
    const created = f.create();
    const uploading = f.create();
    await f.addPart(uploading, 0);
    const projectSource = path.join(f.root, "projects", f.project.id, "uploads", "unrelated.e57");
    fs.mkdirSync(path.dirname(projectSource), { recursive: true });
    fs.writeFileSync(projectSource, "canonical");
    f.advanceDays(4);
    const result = await f.makeCleanup().sweep();
    assert.equal(result.expired, 2);
    assert.equal(result.bytesReclaimed, 4);
    assert.equal(f.service.getSession(created.uploadId).status, "expired");
    assert.equal(f.service.getSession(uploading.uploadId).status, "expired");
    assert.equal(fs.existsSync(f.repository.getPartPath(uploading.uploadId, 0)), false);
    assert.equal(fs.readFileSync(projectSource, "utf8"), "canonical");
    await assert.rejects(f.addPart(uploading, 1), /expired/i);
    await assert.rejects(f.service.completeSession(uploading.uploadId), /expired/i);
    assert.equal((await f.makeCleanup().sweep()).bytesReclaimed, 0);
});

test("recent successful part refreshes expiry and an active part stream blocks cleanup", async () => {
    const f = fixture();
    const session = f.create();
    f.advanceDays(2);
    await f.addPart(session, 0);
    f.advanceDays(2);
    assert.equal((await f.makeCleanup().sweep()).expired, 0);
    const body = new PassThrough();
    const pending = f.service.uploadPart({ uploadId: session.uploadId, partNumber: 1,
        contentLength: "4", contentType: "application/octet-stream", body });
    body.write("ab");
    f.advanceDays(4);
    assert.equal((await f.makeCleanup().sweep()).expired, 0);
    body.end("cd");
    await assert.rejects(pending, /expired/i);
    assert.equal((await f.makeCleanup().sweep()).expired, 1);
});

test("complete but unregistered and finalizing sessions retain recovery bytes", async () => {
    const f = fixture();
    const completed = await f.finalize(f.create());
    const finalizing = f.create("ifc");
    await f.addPart(finalizing, 0);
    const current = f.repository.get(finalizing.uploadId)!;
    f.repository.save({ ...current, status: "finalizing", finalizationStartedAt: current.updatedAt });
    f.advanceDays(40);
    await f.makeCleanup().sweep();
    assert.equal(fs.existsSync(f.repository.getFinalizedArtifactPath(completed)), true);
    assert.equal(fs.existsSync(f.repository.getPartPath(completed.uploadId, 0)), true);
    assert.equal(fs.existsSync(f.repository.getPartPath(finalizing.uploadId, 0)), true);
    assert.equal(f.repository.get(finalizing.uploadId)?.status, "finalizing");
});

test("registered complete session reclaims only session bytes and survives a restarted service", async () => {
    const f = fixture();
    const completed = await f.finalize(f.create());
    const source = f.register(completed);
    const derivative = path.join(f.root, "projects", f.project.id, "converted", completed.reservedFileId, "cloud.las");
    fs.mkdirSync(path.dirname(derivative), { recursive: true });
    fs.writeFileSync(derivative, "derivative");
    const hashBefore = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    const cleanup = f.makeCleanup(f.makeService());
    const first = await cleanup.sweep();
    assert.equal(first.bytesReclaimed, 8);
    assert.equal(f.repository.get(completed.uploadId)?.temporaryDataCleanedAt !== undefined, true);
    assert.equal(f.makeService().getSession(completed.uploadId).status, "complete");
    assert.equal(fs.existsSync(f.repository.getPartPath(completed.uploadId, 0)), false);
    assert.equal(createHash("sha256").update(fs.readFileSync(source)).digest("hex"), hashBefore);
    assert.equal(fs.readFileSync(derivative, "utf8"), "derivative");
    assert.equal(f.project.files.length, 1);
    assert.equal((await f.makeCleanup(f.makeService()).sweep()).bytesReclaimed, 0);
});

test("registered marker alone cannot authorize cleanup when canonical source is missing", async () => {
    const f = fixture();
    const completed = await f.finalize(f.create());
    const source = f.register(completed);
    fs.unlinkSync(source);
    await f.makeCleanup().sweep();
    assert.equal(fs.existsSync(f.repository.getPartPath(completed.uploadId, 0)), true);
    assert.equal(f.repository.get(completed.uploadId)?.temporaryDataCleanupStartedAt, undefined);
});

test("cancelled sessions keep a small tombstone, while retryable failures preserve parts", async () => {
    const f = fixture();
    const cancelled = f.create();
    await f.addPart(cancelled, 0);
    await f.service.cancelSession(cancelled.uploadId);
    const failed = f.create("ifc");
    await f.addPart(failed, 0);
    const current = f.repository.get(failed.uploadId)!;
    f.repository.save({ ...current, status: "failed", error: { code: "TEST", message: "retry", retryable: true } });
    f.advanceDays(40);
    await f.makeCleanup().sweep();
    assert.equal(f.repository.get(cancelled.uploadId)?.status, "cancelled");
    assert.equal(fs.existsSync(f.repository.getPartPath(failed.uploadId, 0)), true);
    assert.equal(f.repository.get(failed.uploadId)?.status, "failed");
    f.advanceDays(31);
    await f.makeCleanup().sweep();
    assert.equal(f.repository.get(cancelled.uploadId), undefined);
});

test("stale known orphan temps are removed; fresh and invalid/unknown data are preserved", async () => {
    const f = fixture();
    const session = f.create();
    const directory = f.repository.getSessionDirectory(session.uploadId);
    const oldPart = path.join(f.repository.getPartsDirectory(session.uploadId), `.00000001.${randomUUID()}.tmp`);
    const freshPart = path.join(f.repository.getPartsDirectory(session.uploadId), `.00000002.${randomUUID()}.tmp`);
    const oldManifest = path.join(directory, `session.json.${randomUUID()}.tmp`);
    const unknown = path.join(directory, "unknown.bin");
    for (const file of [oldPart, freshPart, oldManifest, unknown]) fs.writeFileSync(file, "temp");
    const oldDate = new Date("2026-09-20T00:00:00.000Z");
    fs.utimesSync(oldPart, oldDate, oldDate);
    fs.utimesSync(oldManifest, oldDate, oldDate);
    const invalidDirectory = path.join(f.repository.getRootDirectory(), randomUUID());
    fs.mkdirSync(invalidDirectory);
    fs.writeFileSync(path.join(invalidDirectory, "unknown.bin"), "keep");
    const result = await f.makeCleanup().sweep();
    assert.equal(result.orphanTemps, 2);
    assert.equal(fs.existsSync(oldPart), false);
    assert.equal(fs.existsSync(oldManifest), false);
    assert.equal(fs.existsSync(freshPart), true);
    assert.equal(fs.existsSync(unknown), true);
    assert.equal(fs.existsSync(path.join(invalidDirectory, "unknown.bin")), true);
});

test("cleanup failure retains a retryable manifest and succeeds on the next sweep", async () => {
    const f = fixture();
    const completed = await f.finalize(f.create());
    f.register(completed);
    const parts = f.repository.getPartsDirectory(completed.uploadId);
    const parked = path.join(f.repository.getSessionDirectory(completed.uploadId), "parts-parked");
    fs.renameSync(parts, parked);
    fs.writeFileSync(parts, "not-a-directory");
    assert.equal((await f.makeCleanup().sweep()).failures, 1);
    assert.equal(f.repository.get(completed.uploadId)?.temporaryDataCleanupStartedAt !== undefined, true);
    fs.unlinkSync(parts);
    fs.renameSync(parked, parts);
    assert.equal((await f.makeCleanup().sweep()).bytesReclaimed, 8);
    assert.equal(f.repository.get(completed.uploadId)?.temporaryDataCleanedAt !== undefined, true);
});
