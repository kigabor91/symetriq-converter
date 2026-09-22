import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import express from "express";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import { createUploadSessionRouter } from "./uploadSessionRoutes.js";
import {
    calculateTotalParts,
    UploadSessionError,
    UploadSessionService,
    type CreateUploadSessionInput,
} from "./uploadSessionService.js";
import {
    DEFAULT_MAX_RESUMABLE_UPLOAD_BYTES,
    DEFAULT_UPLOAD_CHUNK_SIZE_BYTES,
    toUploadSessionResponse,
} from "./uploadSessionTypes.js";

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

function createFixture(now = new Date("2026-09-22T10:00:00.000Z")) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-upload-session-"));
    temporaryDirectories.push(directory);
    const root = path.join(directory, "upload-sessions");
    const projects = new Set(["project-1"]);
    const repository = new UploadSessionRepository(root);
    const service = new UploadSessionService(repository, (projectId) => projects.has(projectId), {
        now: () => new Date(now),
        logger: silentLogger,
    });
    return { directory, root, projects, repository, service };
}

function validInput(overrides: Partial<CreateUploadSessionInput> = {}): CreateUploadSessionInput {
    return {
        projectId: "project-1",
        filename: "survey.e57",
        mimeType: "application/octet-stream",
        fileKind: "structured-e57",
        totalBytes: 270 * 1024 ** 2,
        ...overrides,
    };
}

function expectUploadError(callback: () => unknown, code: UploadSessionError["code"]): UploadSessionError {
    try {
        callback();
    } catch (error) {
        assert.ok(error instanceof UploadSessionError);
        assert.equal(error.code, code);
        return error;
    }
    throw new Error("Expected UploadSessionError.");
}

test("creates a persistent small upload session with server-authoritative defaults", () => {
    const { repository, service } = createFixture();
    const { session, created } = service.createSession(validInput({ totalBytes: 1024 }));

    assert.equal(created, true);
    assert.equal(session.chunkSize, 64 * 1024 ** 2);
    assert.equal(session.totalParts, 1);
    assert.equal(session.receivedBytes, 0);
    assert.deepEqual(session.parts, []);
    assert.equal(session.status, "created");
    assert.equal(session.expiresAt, "2026-09-25T10:00:00.000Z");
    assert.ok(fs.existsSync(path.join(repository.getSessionDirectory(session.uploadId), "session.json")));
    assert.ok(fs.existsSync(repository.getPartsDirectory(session.uploadId)));

    const response = toUploadSessionResponse(session);
    assert.deepEqual(response.uploadedParts, []);
    assert.equal("idempotencyKey" in response, false);
    assert.equal("normalizedExtension" in response, false);
});

test("calculates part counts without int32 coercion", () => {
    const chunk = DEFAULT_UPLOAD_CHUNK_SIZE_BYTES;
    assert.equal(calculateTotalParts(chunk - 1), 1);
    assert.equal(calculateTotalParts(chunk), 1);
    assert.equal(calculateTotalParts(chunk * 3), 3);
    assert.equal(calculateTotalParts(chunk * 3 + 1), 4);
    assert.equal(calculateTotalParts(2_392_272_089), 36);
    assert.equal(calculateTotalParts(10 * 1024 ** 3), 160);
});

test("preserves multi-gigabyte sizes exactly in the durable manifest", () => {
    const { repository, root, service } = createFixture();
    const sourceBytes = 2_392_272_089;
    const created = service.createSession(validInput({ totalBytes: sourceBytes })).session;
    assert.equal(created.totalBytes, sourceBytes);
    assert.equal(created.totalParts, 36);

    const manifest = JSON.parse(fs.readFileSync(
        path.join(repository.getSessionDirectory(created.uploadId), "session.json"),
        "utf8",
    )) as { totalBytes: number };
    assert.equal(manifest.totalBytes, sourceBytes);

    const restarted = new UploadSessionService(
        new UploadSessionRepository(root),
        (projectId) => projectId === "project-1",
        { logger: silentLogger },
    );
    assert.equal(restarted.getSession(created.uploadId).totalBytes, sourceBytes);
});

test("accepts a 10 GiB-class upload", () => {
    const { service } = createFixture();
    const session = service.createSession(validInput({ totalBytes: 10 * 1024 ** 3 })).session;
    assert.equal(session.totalBytes, 10_737_418_240);
    assert.equal(session.totalParts, 160);
});

test("rejects zero, negative, fractional and unsafe sizes", () => {
    const { service } = createFixture();
    for (const totalBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2392272089"]) {
        expectUploadError(
            () => service.createSession(validInput({ totalBytes })),
            "INVALID_FILE_SIZE",
        );
    }
});

test("enforces the configurable 50 GiB default maximum", () => {
    const { service } = createFixture();
    assert.equal(DEFAULT_MAX_RESUMABLE_UPLOAD_BYTES, 50 * 1024 ** 3);
    const maximum = service.createSession(validInput({ totalBytes: DEFAULT_MAX_RESUMABLE_UPLOAD_BYTES })).session;
    assert.equal(maximum.totalParts, 800);
    const error = expectUploadError(
        () => service.createSession(validInput({ totalBytes: DEFAULT_MAX_RESUMABLE_UPLOAD_BYTES + 1 })),
        "UPLOAD_TOO_LARGE",
    );
    assert.equal(error.statusCode, 413);
});

test("rejects unsafe filenames and mismatched file kinds", () => {
    const { service } = createFixture();
    for (const filename of ["", " ", ".", "..", "../survey.e57", "folder/survey.e57", "C:\\survey.e57", "bad?.e57"]) {
        expectUploadError(
            () => service.createSession(validInput({ filename })),
            filename.length === 0 ? "INVALID_UPLOAD_REQUEST" : "INVALID_FILE_METADATA",
        );
    }
    expectUploadError(
        () => service.createSession(validInput({ filename: "survey.laz", fileKind: "structured-e57" })),
        "INVALID_FILE_METADATA",
    );
});

test("requires an existing project", () => {
    const { service } = createFixture();
    expectUploadError(
        () => service.createSession(validInput({ projectId: "missing-project" })),
        "PROJECT_NOT_FOUND",
    );
});

test("returns the same session for an identical idempotent create", () => {
    const { service } = createFixture();
    const input = validInput({ idempotencyKey: "upload-attempt-1" });
    const first = service.createSession(input);
    const second = service.createSession(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.session.uploadId, first.session.uploadId);
});

test("rejects conflicting reuse of an idempotency key", () => {
    const { service } = createFixture();
    service.createSession(validInput({ idempotencyKey: "upload-attempt-1" }));
    expectUploadError(
        () => service.createSession(validInput({ idempotencyKey: "upload-attempt-1", totalBytes: 999 })),
        "IDEMPOTENCY_CONFLICT",
    );
});

test("reloads an identical session from a fresh repository and service", () => {
    const { root, service } = createFixture();
    const original = service.createSession(validInput({
        expectedSha256: "A".repeat(64),
        idempotencyKey: "persistent-request",
    })).session;
    const restartedRepository = new UploadSessionRepository(root);
    const restartedService = new UploadSessionService(
        restartedRepository,
        (projectId) => projectId === "project-1",
        { logger: silentLogger },
    );
    assert.deepEqual(restartedService.getSession(original.uploadId), original);
});

test("GET remains read-only after expiresAt until a maintenance sweep transitions state", () => {
    const { root, service } = createFixture();
    const original = service.createSession(validInput()).session;
    const laterService = new UploadSessionService(
        new UploadSessionRepository(root),
        (projectId) => projectId === "project-1",
        { now: () => new Date("2026-09-30T10:00:00.000Z"), logger: silentLogger },
    );
    const loaded = laterService.getSession(original.uploadId);
    assert.equal(loaded.status, "created");
    assert.equal(loaded.expiresAt, "2026-09-25T10:00:00.000Z");
});

test("reports a missing or malformed upload ID without path traversal", () => {
    const { service } = createFixture();
    expectUploadError(() => service.getSession("00000000-0000-4000-8000-000000000000"), "UPLOAD_NOT_FOUND");
    expectUploadError(() => service.getSession("../../projects.json"), "UPLOAD_NOT_FOUND");
});

test("cancellation is durable, idempotent and removes temporary data only", async () => {
    const { repository, service } = createFixture();
    const session = service.createSession(validInput()).session;
    fs.writeFileSync(path.join(repository.getPartsDirectory(session.uploadId), "placeholder.part"), "temporary");

    const cancelled = await service.cancelSession(session.uploadId);
    const repeated = await service.cancelSession(session.uploadId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(repeated.status, "cancelled");
    assert.equal(repeated.uploadId, session.uploadId);
    assert.equal(fs.existsSync(repository.getPartsDirectory(session.uploadId)), false);
    assert.ok(fs.existsSync(path.join(repository.getSessionDirectory(session.uploadId), "session.json")));
    assert.equal(service.getSession(session.uploadId).status, "cancelled");
});

test("atomic manifest replacement leaves one valid manifest and no temp file", () => {
    const { repository, service } = createFixture();
    const session = service.createSession(validInput()).session;
    const updated = { ...session, status: "failed" as const, updatedAt: "2026-09-22T11:00:00.000Z" };
    repository.save(updated);

    const entries = fs.readdirSync(repository.getSessionDirectory(session.uploadId));
    assert.equal(entries.filter((entry) => entry.includes("session.json.") && entry.endsWith(".tmp")).length, 0);
    assert.equal(repository.get(session.uploadId)?.status, "failed");
});

test("repository rejects invalid uploaded-part invariants", () => {
    const { repository, service } = createFixture();
    const session = service.createSession(validInput()).session;
    assert.throws(() => repository.save({
        ...session,
        receivedBytes: session.chunkSize,
        parts: [
            { partNumber: 0, size: session.chunkSize, sha256: "a".repeat(64), completedAt: "2026-09-22T10:00:00.000Z" },
            { partNumber: 0, size: session.chunkSize, sha256: "b".repeat(64), completedAt: "2026-09-22T10:00:00.000Z" },
        ],
    }), /duplicate part/i);
});

test("POST, GET and DELETE expose the canonical upload-session API", async () => {
    const { service } = createFixture();
    const app = express();
    app.use(express.json());
    app.use(createUploadSessionRouter(service));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
        const createResponse = await fetch(`${base}/api/projects/project-1/uploads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": "route-test" },
            body: JSON.stringify({
                filename: "large.e57",
                mimeType: "application/octet-stream",
                fileKind: "structured-e57",
                totalBytes: 2_392_272_089,
            }),
        });
        assert.equal(createResponse.status, 201);
        const created = await createResponse.json() as { uploadId: string; totalBytes: number; totalParts: number; uploadedParts: number[] };
        assert.equal(created.totalBytes, 2_392_272_089);
        assert.equal(created.totalParts, 36);
        assert.deepEqual(created.uploadedParts, []);
        assert.equal(createResponse.headers.get("location"), `/api/uploads/${created.uploadId}`);

        const replayResponse = await fetch(`${base}/api/projects/project-1/uploads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": "route-test" },
            body: JSON.stringify({
                filename: "large.e57",
                mimeType: "application/octet-stream",
                fileKind: "structured-e57",
                totalBytes: 2_392_272_089,
            }),
        });
        assert.equal(replayResponse.status, 200);
        assert.equal((await replayResponse.json() as { uploadId: string }).uploadId, created.uploadId);

        const getResponse = await fetch(`${base}/api/uploads/${created.uploadId}`);
        assert.equal(getResponse.status, 200);
        assert.equal((await getResponse.json() as { status: string }).status, "created");

        const cancelResponse = await fetch(`${base}/api/uploads/${created.uploadId}`, { method: "DELETE" });
        assert.equal(cancelResponse.status, 200);
        assert.equal((await cancelResponse.json() as { status: string }).status, "cancelled");

        const repeatedCancel = await fetch(`${base}/api/uploads/${created.uploadId}`, { method: "DELETE" });
        assert.equal(repeatedCancel.status, 200);
        assert.equal((await repeatedCancel.json() as { status: string }).status, "cancelled");
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
