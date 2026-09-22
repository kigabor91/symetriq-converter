import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import { createUploadSessionRouter } from "./uploadSessionRoutes.js";
import {
    finalizationPercent,
    requiredFinalizationFreeBytes,
    UploadSessionError,
    UploadSessionService,
    type UploadSessionServiceOptions,
} from "./uploadSessionService.js";
import type { UploadFileKind, UploadSessionRecord } from "./uploadSessionTypes.js";

const temporaryDirectories: string[] = [];
const silentLogger = { info: (_message: string) => undefined, error: (_message: string) => undefined };

afterEach(() => {
    while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function fixture(options: UploadSessionServiceOptions = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-upload-finalize-"));
    temporaryDirectories.push(directory);
    const root = path.join(directory, "upload-sessions");
    const repository = new UploadSessionRepository(root);
    const service = new UploadSessionService(repository, (projectId) => projectId === "project-1", {
        chunkSize: 4,
        getFreeDiskBytes: () => Number.MAX_SAFE_INTEGER,
        logger: silentLogger,
        ...options,
    });
    return { root, repository, service };
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function createSession(
    service: UploadSessionService,
    bytes: Buffer,
    kind: UploadFileKind = "structured-e57",
    expectedSha256?: string,
): UploadSessionRecord {
    const filename = kind === "ifc" ? "building.ifc" : kind === "point-cloud" ? "scan.las" : "scan.e57";
    return service.createSession({
        projectId: "project-1",
        filename,
        fileKind: kind,
        mimeType: "application/octet-stream",
        totalBytes: bytes.length,
        expectedSha256,
    }).session;
}

async function uploadAll(service: UploadSessionService, session: UploadSessionRecord, bytes: Buffer): Promise<void> {
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
}

async function finalize(service: UploadSessionService, uploadId: string): Promise<UploadSessionRecord> {
    const requested = await service.completeSession(uploadId);
    assert.equal(requested.session.status, "finalizing");
    return service.waitForFinalization(uploadId);
}

async function expectError(action: Promise<unknown>, code: UploadSessionError["code"]): Promise<void> {
    await assert.rejects(action, (error: unknown) => error instanceof UploadSessionError && error.code === code);
}

test("streams all parts into one byte-identical finalized artifact with a partial final chunk", async () => {
    const { repository, service } = fixture();
    const bytes = Buffer.from("abcdefghij");
    const session = createSession(service, bytes, "structured-e57", sha256(bytes));
    await uploadAll(service, session, bytes);
    const complete = await finalize(service, session.uploadId);

    assert.equal(complete.status, "complete");
    assert.equal(complete.finalBytes, bytes.length);
    assert.equal(complete.finalSha256, sha256(bytes));
    assert.equal(complete.finalizedArtifactName, repository.getFinalizedArtifactName(complete));
    assert.deepEqual(fs.readFileSync(repository.getFinalizedArtifactPath(complete)), bytes);
    assert.equal(fs.readdirSync(repository.getPartsDirectory(session.uploadId)).length, 3);
});

test("rejects completion while a required part is missing", async () => {
    const { service } = fixture();
    const bytes = Buffer.from("abcdefgh");
    const session = createSession(service, bytes);
    await service.uploadPart({
        uploadId: session.uploadId,
        partNumber: 0,
        contentLength: "4",
        contentType: "application/octet-stream",
        body: Readable.from([Buffer.from("abcd")]),
    });
    await expectError(service.completeSession(session.uploadId), "UPLOAD_INCOMPLETE");
    assert.equal(service.getSession(session.uploadId).status, "uploading");
});

test("expected whole-file hash succeeds on match and fails without promoting on mismatch", async () => {
    const matching = fixture();
    const bytes = Buffer.from("abcdefgh");
    const good = createSession(matching.service, bytes, "ifc", sha256(bytes));
    await uploadAll(matching.service, good, bytes);
    assert.equal((await finalize(matching.service, good.uploadId)).status, "complete");

    const mismatching = fixture();
    const bad = createSession(mismatching.service, bytes, "ifc", "0".repeat(64));
    await uploadAll(mismatching.service, bad, bytes);
    const failed = await finalize(mismatching.service, bad.uploadId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.code, "FINAL_HASH_MISMATCH");
    assert.equal(failed.error?.retryable, false);
    assert.equal(fs.existsSync(mismatching.repository.getFinalizedArtifactPath(bad)), false);
    assert.equal(fs.existsSync(mismatching.repository.getAssemblyTemporaryPath(bad.uploadId)), false);
    assert.equal(fs.readdirSync(mismatching.repository.getPartsDirectory(bad.uploadId)).length, 2);
});

test("same-size part corruption is detected by persisted SHA-256 revalidation", async () => {
    const { repository, service } = fixture();
    const bytes = Buffer.from("abcdefgh");
    const session = createSession(service, bytes);
    await uploadAll(service, session, bytes);
    fs.writeFileSync(repository.getPartPath(session.uploadId, 1), "WXYZ");
    const failed = await finalize(service, session.uploadId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.code, "PART_INTEGRITY_MISMATCH");
    assert.equal(fs.existsSync(repository.getFinalizedArtifactPath(session)), false);
});

test("complete is idempotent and concurrent requests share one authoritative task and artifact", async () => {
    let assemblyStarts = 0;
    const { repository, service } = fixture({
        finalizationFaultInjector: (stage) => {
            if (stage === "before-assembly") assemblyStarts += 1;
        },
    });
    const bytes = Buffer.from("abcdefgh");
    const session = createSession(service, bytes);
    await uploadAll(service, session, bytes);
    const [first, second] = await Promise.all([
        service.completeSession(session.uploadId),
        service.completeSession(session.uploadId),
    ]);
    assert.equal(first.session.status, "finalizing");
    assert.ok(["finalizing", "complete"].includes(second.session.status));
    const complete = await service.waitForFinalization(session.uploadId);
    const finalPath = repository.getFinalizedArtifactPath(complete);
    const initialMtime = fs.statSync(finalPath).mtimeMs;
    const replay = await service.completeSession(session.uploadId);
    assert.equal(replay.alreadyComplete, true);
    assert.equal(replay.session.finalSha256, sha256(bytes));
    assert.equal(fs.statSync(finalPath).mtimeMs, initialMtime);
    assert.equal(assemblyStarts, 1);
});

test("restart recovery discards a partial temp assembly and restarts from part zero", async () => {
    const { root, repository, service } = fixture();
    const bytes = Buffer.from("abcdefghij");
    const session = createSession(service, bytes);
    await uploadAll(service, session, bytes);
    const current = service.getSession(session.uploadId);
    repository.save({
        ...current,
        status: "finalizing",
        finalizationStartedAt: "2026-09-22T12:00:00.000Z",
        finalizationUpdatedAt: "2026-09-22T12:00:00.000Z",
    });
    repository.prepareFinalizationDirectories(session.uploadId);
    fs.writeFileSync(repository.getAssemblyTemporaryPath(session.uploadId), "partial-garbage");

    const restarted = new UploadSessionService(
        new UploadSessionRepository(root),
        () => true,
        { chunkSize: 4, getFreeDiskBytes: () => Number.MAX_SAFE_INTEGER, logger: silentLogger },
    );
    assert.equal(restarted.getSessionStatus(session.uploadId).status, "finalizing");
    const complete = await restarted.waitForFinalization(session.uploadId);
    assert.equal(complete.status, "complete");
    assert.deepEqual(fs.readFileSync(repository.getFinalizedArtifactPath(complete)), bytes);
    assert.equal(fs.existsSync(repository.getAssemblyTemporaryPath(session.uploadId)), false);
});

test("restart reconciles an atomically promoted artifact before manifest completion", async () => {
    const { root, repository, service } = fixture();
    const bytes = Buffer.from("abcdefgh");
    const session = createSession(service, bytes);
    await uploadAll(service, session, bytes);
    const current = service.getSession(session.uploadId);
    repository.save({
        ...current,
        status: "finalizing",
        finalizationStartedAt: "2026-09-22T12:00:00.000Z",
        finalizationUpdatedAt: "2026-09-22T12:00:00.000Z",
    });
    repository.prepareFinalizationDirectories(session.uploadId);
    fs.writeFileSync(repository.getFinalizedArtifactPath(current), bytes);
    const originalMtime = fs.statSync(repository.getFinalizedArtifactPath(current)).mtimeMs;

    const restarted = new UploadSessionService(
        new UploadSessionRepository(root),
        () => true,
        { chunkSize: 4, getFreeDiskBytes: () => 0, logger: silentLogger },
    );
    restarted.getSessionStatus(session.uploadId);
    const complete = await restarted.waitForFinalization(session.uploadId);
    assert.equal(complete.status, "complete");
    assert.equal(complete.finalSha256, sha256(bytes));
    assert.equal(fs.statSync(repository.getFinalizedArtifactPath(complete)).mtimeMs, originalMtime);
});

test("disk-space and injected write failures preserve immutable parts and expose retryable state", async () => {
    const lowDisk = fixture({ getFreeDiskBytes: () => 1 });
    const bytes = Buffer.from("abcdefgh");
    const lowDiskSession = createSession(lowDisk.service, bytes);
    await uploadAll(lowDisk.service, lowDiskSession, bytes);
    const diskFailed = await finalize(lowDisk.service, lowDiskSession.uploadId);
    assert.equal(diskFailed.status, "failed");
    assert.equal(diskFailed.error?.code, "INSUFFICIENT_DISK_SPACE");
    assert.equal(diskFailed.error?.retryable, true);
    assert.equal(fs.readdirSync(lowDisk.repository.getPartsDirectory(lowDiskSession.uploadId)).length, 2);

    let injected = false;
    const writeFailure = fixture({
        finalizationFaultInjector: (stage, processedBytes) => {
            if (!injected && stage === "during-assembly" && processedBytes > 0) {
                injected = true;
                throw Object.assign(new Error("simulated disk failure"), { code: "EIO" });
            }
        },
    });
    const writeSession = createSession(writeFailure.service, bytes);
    await uploadAll(writeFailure.service, writeSession, bytes);
    const writeFailed = await finalize(writeFailure.service, writeSession.uploadId);
    assert.equal(writeFailed.status, "failed");
    assert.equal(writeFailed.error?.code, "FINALIZATION_IO_FAILED");
    assert.equal(fs.existsSync(writeFailure.repository.getAssemblyTemporaryPath(writeSession.uploadId)), false);
    assert.equal(fs.existsSync(writeFailure.repository.getFinalizedArtifactPath(writeSession)), false);
    assert.equal(fs.readdirSync(writeFailure.repository.getPartsDirectory(writeSession.uploadId)).length, 2);

    const restarted = new UploadSessionService(
        new UploadSessionRepository(writeFailure.repository.getRootDirectory()),
        () => true,
        { chunkSize: 4, getFreeDiskBytes: () => Number.MAX_SAFE_INTEGER, logger: silentLogger },
    );
    const retried = await finalize(restarted, writeSession.uploadId);
    assert.equal(retried.status, "complete");
    assert.deepEqual(fs.readFileSync(writeFailure.repository.getFinalizedArtifactPath(retried)), bytes);
});

test("cancelled, expired and non-retryable failed sessions cannot finalize", async () => {
    for (const status of ["cancelled", "expired"] as const) {
        const { repository, service } = fixture();
        const bytes = Buffer.from("data");
        const session = createSession(service, bytes);
        repository.save({ ...session, status });
        await expectError(service.completeSession(session.uploadId), status === "cancelled" ? "UPLOAD_CANCELLED" : "UPLOAD_EXPIRED");
    }
    const { repository, service } = fixture();
    const session = createSession(service, Buffer.from("data"));
    repository.save({
        ...session,
        status: "failed",
        error: { code: "FINAL_HASH_MISMATCH", message: "bad hash", retryable: false },
    });
    await expectError(service.completeSession(session.uploadId), "FINALIZATION_NOT_ALLOWED");
});

test("safe finalization arithmetic remains exact above 2 GiB", () => {
    const totalBytes = 4_400_000_000;
    assert.equal(requiredFinalizationFreeBytes(totalBytes), 4_936_870_912);
    assert.equal(finalizationPercent(2_200_000_000, totalBytes), 50);
    assert.equal(finalizationPercent(totalBytes, totalBytes), 100);
});

test("E57 and IFC use the same generic finalization path", async () => {
    const { repository, service } = fixture();
    const bytes = Buffer.from("generic-upload");
    for (const kind of ["structured-e57", "ifc"] as const) {
        const session = createSession(service, bytes, kind);
        await uploadAll(service, session, bytes);
        const complete = await finalize(service, session.uploadId);
        assert.equal(complete.finalSha256, sha256(bytes));
        assert.deepEqual(fs.readFileSync(repository.getFinalizedArtifactPath(complete)), bytes);
    }
});

test("POST complete returns 202 and GET exposes a stable completed result", async () => {
    const { service } = fixture();
    const bytes = Buffer.from("abcdefgh");
    const session = createSession(service, bytes);
    await uploadAll(service, session, bytes);
    const app = express();
    app.use(express.json());
    app.use(createUploadSessionRouter(service));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
        const accepted = await fetch(`http://127.0.0.1:${port}/api/uploads/${session.uploadId}/complete`, { method: "POST" });
        assert.equal(accepted.status, 202);
        assert.equal((await accepted.json() as { status: string }).status, "finalizing");
        await service.waitForFinalization(session.uploadId);
        const loaded = await fetch(`http://127.0.0.1:${port}/api/uploads/${session.uploadId}`);
        const result = await loaded.json() as { status: string; finalBytes: number; finalSha256: string; finalizedArtifactName: string };
        assert.equal(result.status, "complete");
        assert.equal(result.finalBytes, bytes.length);
        assert.equal(result.finalSha256, sha256(bytes));
        assert.ok(result.finalizedArtifactName.endsWith(".e57"));
        assert.equal(JSON.stringify(result).includes(path.sep + "upload-sessions" + path.sep), false);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
