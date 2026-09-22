import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import { createUploadSessionRouter } from "./uploadSessionRoutes.js";
import {
    UploadSessionError,
    UploadSessionService,
    type UploadPartInput,
} from "./uploadSessionService.js";

const temporaryDirectories: string[] = [];
const silentLogger = {
    info: (_message: string) => undefined,
    error: (_message: string) => undefined,
};

afterEach(() => {
    while (temporaryDirectories.length > 0) {
        fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
    }
});

function fixture(chunkSize = 4, now = new Date("2026-09-22T10:00:00.000Z")) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-upload-part-"));
    temporaryDirectories.push(directory);
    const root = path.join(directory, "upload-sessions");
    const repository = new UploadSessionRepository(root);
    const service = new UploadSessionService(repository, (projectId) => projectId === "project-1", {
        chunkSize,
        now: () => new Date(now),
        logger: silentLogger,
    });
    return { directory, root, repository, service };
}

function createSession(service: UploadSessionService, totalBytes: number, fileKind: "structured-e57" | "ifc" | "point-cloud" = "structured-e57") {
    const filename = fileKind === "ifc" ? "building.ifc" : fileKind === "point-cloud" ? "scan.las" : "scan.e57";
    return service.createSession({
        projectId: "project-1",
        filename,
        mimeType: "application/octet-stream",
        fileKind,
        totalBytes,
    }).session;
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

async function putPart(
    service: UploadSessionService,
    uploadId: string,
    partNumber: number | string,
    bytes: Buffer,
    overrides: Partial<UploadPartInput> = {},
) {
    return service.uploadPart({
        uploadId,
        partNumber,
        contentLength: String(bytes.length),
        contentType: "application/octet-stream",
        body: Readable.from([bytes]),
        ...overrides,
    });
}

async function expectUploadError(promise: Promise<unknown>, code: UploadSessionError["code"]): Promise<UploadSessionError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof UploadSessionError);
        assert.equal(error.code, code);
        return error;
    }
    throw new Error("Expected UploadSessionError.");
}

function delayedBody(bytes: Buffer, waitMs: number): Readable {
    return Readable.from((async function* () {
        await delay(waitMs);
        yield bytes;
    })());
}

test("streams normal, middle and final partial parts to immutable disk files", async () => {
    const { repository, service } = fixture();
    const session = createSession(service, 10);
    const first = await putPart(service, session.uploadId, 0, Buffer.from("abcd"));
    const middle = await putPart(service, session.uploadId, 1, Buffer.from("efgh"));
    const final = await putPart(service, session.uploadId, 2, Buffer.from("ij"));

    assert.equal(first.alreadyPresent, false);
    assert.equal(middle.receivedBytes, 8);
    assert.equal(final.size, 2);
    assert.equal(final.sha256, sha256(Buffer.from("ij")));
    assert.equal(fs.readFileSync(repository.getPartPath(session.uploadId, 0), "utf8"), "abcd");
    assert.equal(fs.readFileSync(repository.getPartPath(session.uploadId, 2), "utf8"), "ij");
    const persisted = service.getSession(session.uploadId);
    assert.deepEqual(persisted.parts.map((part) => part.partNumber), [0, 1, 2]);
    assert.equal(persisted.receivedBytes, 10);
    assert.equal(persisted.status, "uploading");
    assert.ok(persisted.parts.every((part) => part.completedAt === "2026-09-22T10:00:00.000Z"));
});

test("supports a one-chunk file and hashes it while streaming", async () => {
    const { repository, service } = fixture();
    const session = createSession(service, 3);
    const content = Buffer.from("abc");
    const result = await putPart(service, session.uploadId, 0, content, { expectedSha256: sha256(content) });

    assert.equal(result.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(result.receivedBytes, 3);
    assert.equal(fs.readFileSync(repository.getPartPath(session.uploadId, 0), "utf8"), "abc");
});

test("rejects header, short-body, oversize-body and final-part size errors", async () => {
    const { repository, service } = fixture();
    const session = createSession(service, 10);
    await expectUploadError(
        putPart(service, session.uploadId, 0, Buffer.from("abc"), { contentLength: "3" }),
        "INVALID_PART_LENGTH",
    );
    await expectUploadError(
        putPart(service, session.uploadId, 0, Buffer.from("abc"), { contentLength: "4" }),
        "PART_SIZE_MISMATCH",
    );
    await expectUploadError(
        putPart(service, session.uploadId, 0, Buffer.from("abcde"), { contentLength: "4" }),
        "PART_SIZE_MISMATCH",
    );
    await expectUploadError(
        putPart(service, session.uploadId, 2, Buffer.from("i"), { contentLength: "1" }),
        "INVALID_PART_LENGTH",
    );
    assert.deepEqual(service.getSession(session.uploadId).parts, []);
    assert.equal(fs.readdirSync(repository.getPartsDirectory(session.uploadId)).length, 0);
});

test("rejects malformed, negative and out-of-range part indexes", async () => {
    const { service } = fixture();
    const session = createSession(service, 8);
    for (const partNumber of ["-1", "1.2", "word", "2"]) {
        await expectUploadError(
            putPart(service, session.uploadId, partNumber, Buffer.from("abcd")),
            "INVALID_PART_NUMBER",
        );
    }
});

test("rejects wrong client-provided SHA-256 without committing a part", async () => {
    const { repository, service } = fixture();
    const session = createSession(service, 4);
    await expectUploadError(
        putPart(service, session.uploadId, 0, Buffer.from("abcd"), { expectedSha256: "0".repeat(64) }),
        "PART_HASH_MISMATCH",
    );
    assert.deepEqual(service.getSession(session.uploadId).parts, []);
    assert.equal(fs.readdirSync(repository.getPartsDirectory(session.uploadId)).length, 0);
});

test("same-content retry is idempotent and a conflicting retry cannot overwrite the part", async () => {
    const { repository, service } = fixture();
    const session = createSession(service, 4);
    const first = await putPart(service, session.uploadId, 0, Buffer.from("abcd"));
    const replay = await putPart(service, session.uploadId, 0, Buffer.from("abcd"));
    await expectUploadError(putPart(service, session.uploadId, 0, Buffer.from("wxyz")), "PART_CONFLICT");

    assert.equal(first.alreadyPresent, false);
    assert.equal(replay.alreadyPresent, true);
    assert.equal(replay.receivedBytes, 4);
    assert.equal(fs.readFileSync(repository.getPartPath(session.uploadId, 0), "utf8"), "abcd");
    assert.equal(service.getSession(session.uploadId).receivedBytes, 4);
});

test("aborted part streams clean temporary files and leave the session resumable", async () => {
    const { repository, service } = fixture();
    const session = createSession(service, 4);
    const aborted = Readable.from((async function* () {
        yield Buffer.from("ab");
        const error = Object.assign(new Error("connection closed"), { code: "ECONNRESET" });
        throw error;
    })());
    await expectUploadError(
        putPart(service, session.uploadId, 0, Buffer.from("abcd"), { body: aborted }),
        "PART_UPLOAD_ABORTED",
    );
    assert.deepEqual(service.getSession(session.uploadId).parts, []);
    assert.equal(fs.readdirSync(repository.getPartsDirectory(session.uploadId)).length, 0);
    await putPart(service, session.uploadId, 0, Buffer.from("abcd"));
    assert.deepEqual(service.getSession(session.uploadId).parts.map((part) => part.partNumber), [0]);
});

test("resume state survives a fresh repository/service and accepts the missing part", async () => {
    const { root, service } = fixture();
    const session = createSession(service, 16);
    await putPart(service, session.uploadId, 0, Buffer.from("0000"));
    await putPart(service, session.uploadId, 1, Buffer.from("1111"));
    await putPart(service, session.uploadId, 3, Buffer.from("3333"));

    const restarted = new UploadSessionService(
        new UploadSessionRepository(root),
        (projectId) => projectId === "project-1",
        { chunkSize: 4, logger: silentLogger },
    );
    assert.deepEqual(restarted.getSession(session.uploadId).parts.map((part) => part.partNumber), [0, 1, 3]);
    await putPart(restarted, session.uploadId, 2, Buffer.from("2222"));
    const restored = restarted.getSession(session.uploadId);
    assert.deepEqual(restored.parts.map((part) => part.partNumber), [0, 1, 2, 3]);
    assert.equal(restored.receivedBytes, 16);
});

test("two different concurrent parts serialize manifest commits without a lost update", async () => {
    const { service } = fixture();
    const session = createSession(service, 8);
    const [first, second] = await Promise.all([
        putPart(service, session.uploadId, 0, Buffer.from("abcd"), { body: delayedBody(Buffer.from("abcd"), 20) }),
        putPart(service, session.uploadId, 1, Buffer.from("efgh"), { body: delayedBody(Buffer.from("efgh"), 0) }),
    ]);
    assert.equal(first.alreadyPresent, false);
    assert.equal(second.alreadyPresent, false);
    const persisted = service.getSession(session.uploadId);
    assert.deepEqual(persisted.parts.map((part) => part.partNumber), [0, 1]);
    assert.equal(persisted.receivedBytes, 8);
});

test("simultaneous duplicate parts resolve as one commit plus one idempotent result", async () => {
    const { service } = fixture();
    const session = createSession(service, 4);
    const results = await Promise.all([
        putPart(service, session.uploadId, 0, Buffer.from("abcd"), { body: delayedBody(Buffer.from("abcd"), 15) }),
        putPart(service, session.uploadId, 0, Buffer.from("abcd"), { body: delayedBody(Buffer.from("abcd"), 0) }),
    ]);
    assert.deepEqual(results.map((result) => result.alreadyPresent).sort(), [false, true]);
    assert.equal(service.getSession(session.uploadId).receivedBytes, 4);
});

test("simultaneous conflicting duplicate parts preserve one immutable payload", async () => {
    const { repository, service } = fixture();
    const session = createSession(service, 4);
    const results = await Promise.allSettled([
        putPart(service, session.uploadId, 0, Buffer.from("abcd"), { body: delayedBody(Buffer.from("abcd"), 15) }),
        putPart(service, session.uploadId, 0, Buffer.from("wxyz"), { body: delayedBody(Buffer.from("wxyz"), 0) }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected" && rejected.reason instanceof UploadSessionError);
    assert.equal(rejected.reason.code, "PART_CONFLICT");
    assert.equal(service.getSession(session.uploadId).receivedBytes, 4);
    assert.ok(["abcd", "wxyz"].includes(fs.readFileSync(repository.getPartPath(session.uploadId, 0), "utf8")));
});

test("a successful part refreshes inactivity expiry by 72 hours", async () => {
    let current = new Date("2026-09-22T10:00:00.000Z");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-upload-expiry-"));
    temporaryDirectories.push(directory);
    const repository = new UploadSessionRepository(path.join(directory, "upload-sessions"));
    const service = new UploadSessionService(repository, (projectId) => projectId === "project-1", {
        chunkSize: 4,
        now: () => new Date(current),
        logger: silentLogger,
    });
    const session = createSession(service, 4);
    current = new Date("2026-09-22T11:30:00.000Z");
    await putPart(service, session.uploadId, 0, Buffer.from("data"));
    const updated = service.getSession(session.uploadId);
    assert.equal(updated.updatedAt, "2026-09-22T11:30:00.000Z");
    assert.equal(updated.expiresAt, "2026-09-25T11:30:00.000Z");
});

test("multi-gigabyte received-byte values round-trip without int32 truncation", () => {
    const largeChunk = 2_200_000_000;
    const { repository, service } = fixture(largeChunk);
    const session = createSession(service, largeChunk * 2);
    const completedAt = "2026-09-22T10:00:00.000Z";
    repository.save({
        ...session,
        status: "uploading",
        receivedBytes: largeChunk * 2,
        parts: [
            { partNumber: 0, size: largeChunk, sha256: "a".repeat(64), completedAt },
            { partNumber: 1, size: largeChunk, sha256: "b".repeat(64), completedAt },
        ],
    });
    assert.equal(repository.get(session.uploadId)?.receivedBytes, 4_400_000_000);
});

test("part byte handling is generic for E57 and IFC sessions", async () => {
    const { service } = fixture();
    const e57 = createSession(service, 4, "structured-e57");
    const ifc = createSession(service, 4, "ifc");
    const [e57Result, ifcResult] = await Promise.all([
        putPart(service, e57.uploadId, 0, Buffer.from("data")),
        putPart(service, ifc.uploadId, 0, Buffer.from("data")),
    ]);
    assert.equal(e57Result.sha256, ifcResult.sha256);
    assert.equal(service.getSession(e57.uploadId).receivedBytes, 4);
    assert.equal(service.getSession(ifc.uploadId).receivedBytes, 4);
});

test("GET does not silently ignore a committed part file missing from the manifest", () => {
    const { repository, service } = fixture();
    const session = createSession(service, 4);
    fs.writeFileSync(repository.getPartPath(session.uploadId, 0), "data");
    assert.throws(() => service.getSession(session.uploadId), (error: unknown) => {
        assert.ok(error instanceof UploadSessionError);
        assert.equal(error.code, "PART_STORAGE_INCONSISTENT");
        return true;
    });
});

test("cancelled, expired and non-active sessions reject part uploads deterministically", async () => {
    const statuses: Array<{ status: "cancelled" | "expired" | "failed" | "finalizing" | "complete"; code: UploadSessionError["code"] }> = [
        { status: "cancelled", code: "UPLOAD_CANCELLED" },
        { status: "expired", code: "UPLOAD_EXPIRED" },
        { status: "failed", code: "UPLOAD_NOT_ACTIVE" },
        { status: "finalizing", code: "UPLOAD_NOT_ACTIVE" },
        { status: "complete", code: "UPLOAD_NOT_ACTIVE" },
    ];
    for (const { status, code } of statuses) {
        const { repository, service } = fixture();
        const session = createSession(service, 4);
        repository.save({ ...session, status });
        await expectUploadError(putPart(service, session.uploadId, 0, Buffer.from("data")), code);
    }
});

test("raw PUT endpoint returns a resumable part result without multipart parsing", async () => {
    const { service } = fixture();
    const session = createSession(service, 4);
    const app = express();
    app.use(express.json());
    app.use(createUploadSessionRouter(service));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
        const content = Buffer.from("data");
        const response = await fetch(`http://127.0.0.1:${port}/api/uploads/${session.uploadId}/parts/0`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Part-SHA256": sha256(content),
            },
            body: content,
        });
        assert.equal(response.status, 201);
        const result = await response.json() as { sha256: string; alreadyPresent: boolean; receivedBytes: number };
        assert.equal(result.sha256, sha256(content));
        assert.equal(result.alreadyPresent, false);
        assert.equal(result.receivedBytes, 4);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
