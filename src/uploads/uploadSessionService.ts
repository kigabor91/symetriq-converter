import * as path from "node:path";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import {
    DEFAULT_MAX_RESUMABLE_UPLOAD_BYTES,
    DEFAULT_UPLOAD_CHUNK_SIZE_BYTES,
    UPLOAD_SESSION_EXPIRY_MS,
    UPLOAD_SESSION_VERSION,
    uploadFileKinds,
    type UploadFileKind,
    type UploadSessionRecord,
} from "./uploadSessionTypes.js";

export type UploadSessionErrorCode =
    | "INVALID_UPLOAD_REQUEST"
    | "INVALID_FILE_SIZE"
    | "UPLOAD_TOO_LARGE"
    | "INVALID_FILE_METADATA"
    | "PROJECT_NOT_FOUND"
    | "UPLOAD_NOT_FOUND"
    | "IDEMPOTENCY_CONFLICT"
    | "UPLOAD_COMPLETE"
    | "INVALID_PART_CONTENT_TYPE"
    | "INVALID_PART_NUMBER"
    | "INVALID_PART_LENGTH"
    | "PART_SIZE_MISMATCH"
    | "PART_HASH_MISMATCH"
    | "PART_CONFLICT"
    | "PART_UPLOAD_ABORTED"
    | "PART_UPLOAD_FAILED"
    | "PART_STORAGE_INCONSISTENT"
    | "UPLOAD_CANCELLED"
    | "UPLOAD_EXPIRED"
    | "UPLOAD_NOT_ACTIVE";

export class UploadSessionError extends Error {
    constructor(
        readonly code: UploadSessionErrorCode,
        message: string,
        readonly statusCode: number,
        readonly retryable = false,
    ) {
        super(message);
        this.name = "UploadSessionError";
    }
}

export interface CreateUploadSessionInput {
    projectId: unknown;
    filename: unknown;
    mimeType?: unknown;
    fileKind: unknown;
    totalBytes: unknown;
    expectedSha256?: unknown;
    idempotencyKey?: unknown;
}

export interface UploadSessionServiceOptions {
    chunkSize?: number;
    maxUploadBytes?: number;
    expiryMs?: number;
    now?: () => Date;
    idFactory?: () => string;
    logger?: UploadSessionLogger;
}

export interface UploadSessionLogger {
    info(message: string): void;
    error(message: string): void;
}

export interface UploadPartInput {
    uploadId: unknown;
    partNumber: unknown;
    contentLength: unknown;
    contentType: unknown;
    expectedSha256?: unknown;
    body: Readable;
}

export interface UploadPartResult {
    uploadId: string;
    partNumber: number;
    size: number;
    sha256: string;
    completedAt: string;
    alreadyPresent: boolean;
    receivedBytes: number;
    totalBytes: number;
    status: "uploading";
}

const extensionByKind: Record<UploadFileKind, ReadonlySet<string>> = {
    "structured-e57": new Set([".e57"]),
    ifc: new Set([".ifc"]),
    "point-cloud": new Set([".las", ".laz"]),
};

const sha256Pattern = /^[0-9a-f]{64}$/i;
const invalidWindowsFilenameCharacter = /[<>:"/\\|?*\u0000-\u001f]/;
const integerPattern = /^\d+$/;

export function calculateTotalParts(totalBytes: number, chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE_BYTES): number {
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0
        || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
        throw new UploadSessionError("INVALID_FILE_SIZE", "File size and chunk size must be positive safe integers.", 400);
    }
    return Math.ceil(totalBytes / chunkSize);
}

export function configuredMaxResumableUploadBytes(raw = process.env.SYMETRIQ_MAX_RESUMABLE_UPLOAD_BYTES): number {
    if (raw === undefined || raw === "") return DEFAULT_MAX_RESUMABLE_UPLOAD_BYTES;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("SYMETRIQ_MAX_RESUMABLE_UPLOAD_BYTES must be a positive safe integer byte count.");
    }
    return parsed;
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new UploadSessionError("INVALID_UPLOAD_REQUEST", `${field} is required.`, 400);
    }
    return value;
}

function validateFilename(value: unknown): { filename: string; extension: string } {
    const filename = requiredString(value, "filename");
    if (filename.trim().length === 0
        || filename.length > 255
        || filename === "."
        || filename === ".."
        || path.win32.isAbsolute(filename)
        || path.posix.isAbsolute(filename)
        || invalidWindowsFilenameCharacter.test(filename)
        || filename.endsWith(" ")
        || filename.endsWith(".")) {
        throw new UploadSessionError("INVALID_FILE_METADATA", "filename must be a safe basename without path components.", 400);
    }
    const extension = path.extname(filename).toLowerCase();
    if (!extension || path.parse(filename).name.length === 0) {
        throw new UploadSessionError("INVALID_FILE_METADATA", "filename must include a supported extension.", 400);
    }
    return { filename, extension };
}

function validateMimeType(value: unknown): string {
    if (value === undefined || value === null || value === "") return "application/octet-stream";
    if (typeof value !== "string"
        || value.length > 255
        || value.trim() !== value
        || /[\u0000-\u001f\u007f]/.test(value)
        || !value.includes("/")) {
        throw new UploadSessionError("INVALID_FILE_METADATA", "mimeType is invalid.", 400);
    }
    return value;
}

function validateFileKind(value: unknown, extension: string): UploadFileKind {
    if (typeof value !== "string" || !uploadFileKinds.includes(value as UploadFileKind)) {
        throw new UploadSessionError("INVALID_FILE_METADATA", "fileKind is not supported.", 400);
    }
    const fileKind = value as UploadFileKind;
    if (!extensionByKind[fileKind].has(extension)) {
        throw new UploadSessionError(
            "INVALID_FILE_METADATA",
            `The ${extension || "selected"} extension is not valid for fileKind ${fileKind}.`,
            400,
        );
    }
    return fileKind;
}

function validateSha256(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !sha256Pattern.test(value)) {
        throw new UploadSessionError("INVALID_FILE_METADATA", "expectedSha256 must be a 64-character hexadecimal value.", 400);
    }
    return value.toLowerCase();
}

function validateIdempotencyKey(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string"
        || value.length > 200
        || value.trim() !== value
        || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new UploadSessionError("INVALID_UPLOAD_REQUEST", "Idempotency-Key is invalid.", 400);
    }
    return value;
}

function validatePartNumber(value: unknown, totalParts: number): number {
    const raw = typeof value === "number" ? String(value) : value;
    if (typeof raw !== "string" || !integerPattern.test(raw)) {
        throw new UploadSessionError("INVALID_PART_NUMBER", "partNumber must be a non-negative integer.", 400);
    }
    const partNumber = Number(raw);
    if (!Number.isSafeInteger(partNumber) || partNumber < 0 || partNumber >= totalParts) {
        throw new UploadSessionError("INVALID_PART_NUMBER", "partNumber is outside the upload session range.", 400);
    }
    return partNumber;
}

function validateContentLength(value: unknown, expectedBytes: number): void {
    const raw = typeof value === "number" ? String(value) : value;
    if (typeof raw !== "string" || !integerPattern.test(raw)) {
        throw new UploadSessionError("INVALID_PART_LENGTH", "Content-Length is required for upload parts.", 400);
    }
    const contentLength = Number(raw);
    if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
        throw new UploadSessionError(
            "INVALID_PART_LENGTH",
            `Part Content-Length must be exactly ${expectedBytes} bytes.`,
            contentLength > expectedBytes ? 413 : 400,
        );
    }
}

function validatePartContentType(value: unknown): void {
    if (typeof value !== "string" || value.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
        throw new UploadSessionError(
            "INVALID_PART_CONTENT_TYPE",
            "Upload parts must use Content-Type application/octet-stream.",
            415,
        );
    }
}

function validatePartSha256(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !sha256Pattern.test(value)) {
        throw new UploadSessionError("INVALID_UPLOAD_REQUEST", "X-Part-SHA256 must be a 64-character hexadecimal value.", 400);
    }
    return value.toLowerCase();
}

function expectedPartBytes(session: UploadSessionRecord, partNumber: number): number {
    const start = partNumber * session.chunkSize;
    return Math.min(session.chunkSize, session.totalBytes - start);
}

function isActiveSession(session: UploadSessionRecord, now: Date): void {
    if (session.status === "cancelled") {
        throw new UploadSessionError("UPLOAD_CANCELLED", "The upload session was cancelled.", 409);
    }
    if (session.status === "expired" || now.getTime() >= Date.parse(session.expiresAt)) {
        throw new UploadSessionError("UPLOAD_EXPIRED", "The upload session has expired.", 410);
    }
    if (session.status !== "created" && session.status !== "uploading") {
        throw new UploadSessionError(
            "UPLOAD_NOT_ACTIVE",
            `The upload session cannot accept parts while status is ${session.status}.`,
            409,
        );
    }
}

function sameCreateRequest(
    session: UploadSessionRecord,
    candidate: Pick<UploadSessionRecord,
        "projectId" | "filename" | "mimeType" | "fileKind" | "totalBytes" | "expectedSha256">,
): boolean {
    return session.projectId === candidate.projectId
        && session.filename === candidate.filename
        && session.mimeType === candidate.mimeType
        && session.fileKind === candidate.fileKind
        && session.totalBytes === candidate.totalBytes
        && session.expectedSha256 === candidate.expectedSha256
        && session.operation === "create";
}

export class UploadSessionService {
    private readonly chunkSize: number;
    private readonly maxUploadBytes: number;
    private readonly expiryMs: number;
    private readonly now: () => Date;
    private readonly idFactory: () => string;
    private readonly logger: UploadSessionLogger;
    private readonly sessionLockTails = new Map<string, Promise<void>>();

    constructor(
        private readonly repository: UploadSessionRepository,
        private readonly projectExists: (projectId: string) => boolean,
        options: UploadSessionServiceOptions = {},
    ) {
        this.chunkSize = options.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE_BYTES;
        this.maxUploadBytes = options.maxUploadBytes ?? configuredMaxResumableUploadBytes();
        this.expiryMs = options.expiryMs ?? UPLOAD_SESSION_EXPIRY_MS;
        this.now = options.now ?? (() => new Date());
        this.idFactory = options.idFactory ?? randomUUID;
        this.logger = options.logger ?? console;
        if (!Number.isSafeInteger(this.chunkSize) || this.chunkSize <= 0
            || !Number.isSafeInteger(this.maxUploadBytes) || this.maxUploadBytes <= 0
            || !Number.isSafeInteger(this.expiryMs) || this.expiryMs <= 0) {
            throw new Error("Upload session service limits must be positive safe integers.");
        }
    }

    createSession(input: CreateUploadSessionInput): { session: UploadSessionRecord; created: boolean } {
        const projectId = requiredString(input.projectId, "projectId");
        if (!this.projectExists(projectId)) {
            throw new UploadSessionError("PROJECT_NOT_FOUND", "Project not found.", 404);
        }
        if (!Number.isSafeInteger(input.totalBytes) || Number(input.totalBytes) <= 0) {
            throw new UploadSessionError("INVALID_FILE_SIZE", "totalBytes must be a positive safe integer.", 400);
        }
        const totalBytes = Number(input.totalBytes);
        if (totalBytes > this.maxUploadBytes) {
            throw new UploadSessionError(
                "UPLOAD_TOO_LARGE",
                `The selected file exceeds the configured ${this.maxUploadBytes} byte upload limit.`,
                413,
            );
        }
        const { filename, extension } = validateFilename(input.filename);
        const mimeType = validateMimeType(input.mimeType);
        const fileKind = validateFileKind(input.fileKind, extension);
        const expectedSha256 = validateSha256(input.expectedSha256);
        const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
        const semanticRequest = {
            projectId,
            filename,
            mimeType,
            fileKind,
            totalBytes,
            ...(expectedSha256 ? { expectedSha256 } : {}),
        };
        if (idempotencyKey) {
            const existing = this.repository.findByIdempotencyKey(projectId, idempotencyKey);
            if (existing) {
                if (!sameCreateRequest(existing, semanticRequest)) {
                    throw new UploadSessionError(
                        "IDEMPOTENCY_CONFLICT",
                        "Idempotency-Key was already used with different upload metadata.",
                        409,
                    );
                }
                this.log("idempotent-create", existing);
                return { session: existing, created: false };
            }
        }
        const now = this.now();
        const timestamp = now.toISOString();
        const session: UploadSessionRecord = {
            version: UPLOAD_SESSION_VERSION,
            uploadId: this.idFactory(),
            projectId,
            filename,
            normalizedExtension: extension,
            mimeType,
            fileKind,
            operation: "create",
            reservedFileId: this.idFactory(),
            totalBytes,
            chunkSize: this.chunkSize,
            totalParts: calculateTotalParts(totalBytes, this.chunkSize),
            receivedBytes: 0,
            status: "created",
            parts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: new Date(now.getTime() + this.expiryMs).toISOString(),
            ...(expectedSha256 ? { expectedSha256 } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
        };
        this.repository.create(session);
        this.log("created", session);
        return { session, created: true };
    }

    getSession(uploadId: string): UploadSessionRecord {
        const session = this.repository.get(uploadId);
        if (!session) throw new UploadSessionError("UPLOAD_NOT_FOUND", "Upload session not found.", 404);
        try {
            this.repository.assertCommittedPartStorage(session);
        } catch (error) {
            this.logger.error(
                `[Upload part storage inconsistent] uploadId=${uploadId}`
                + ` error=${error instanceof Error ? error.message : String(error)}`,
            );
            throw new UploadSessionError(
                "PART_STORAGE_INCONSISTENT",
                "The upload session manifest and committed part storage disagree.",
                500,
                true,
            );
        }
        // Reads are deliberately non-mutating. R2B.6 owns the durable
        // transition to expired; clients can already observe expiresAt.
        this.log("loaded", session);
        return session;
    }

    async uploadPart(input: UploadPartInput): Promise<UploadPartResult> {
        const uploadId = requiredString(input.uploadId, "uploadId");
        const startingSession = this.getSession(uploadId);
        isActiveSession(startingSession, this.now());
        const partNumber = validatePartNumber(input.partNumber, startingSession.totalParts);
        const expectedBytes = expectedPartBytes(startingSession, partNumber);
        validatePartContentType(input.contentType);
        validateContentLength(input.contentLength, expectedBytes);
        const expectedSha256 = validatePartSha256(input.expectedSha256);
        const temporaryPath = this.repository.getTemporaryPartPath(uploadId, partNumber, this.idFactory());
        const startedAt = Date.now();
        this.logPart("start", startingSession, partNumber, `expectedBytes=${expectedBytes}`);

        let streamed: { size: number; sha256: string };
        try {
            streamed = await this.streamPartToTemporaryFile(input.body, temporaryPath, expectedBytes);
            if (expectedSha256 && streamed.sha256 !== expectedSha256) {
                throw new UploadSessionError("PART_HASH_MISMATCH", "X-Part-SHA256 does not match the uploaded bytes.", 422);
            }
            this.fsyncPartFile(temporaryPath);
        } catch (error) {
            const temporaryBytes = this.fileSize(temporaryPath);
            fs.rmSync(temporaryPath, { force: true });
            const aborted = this.isAborted(input.body, error);
            const normalized = error instanceof UploadSessionError
                ? error
                : new UploadSessionError(
                    aborted ? "PART_UPLOAD_ABORTED" : "PART_UPLOAD_FAILED",
                    aborted ? "The upload part request was aborted." : "The upload part stream failed.",
                    aborted ? 400 : 500,
                    !aborted,
                );
            this.logPartError(
                aborted ? "aborted" : "failed",
                startingSession,
                partNumber,
                `${normalized.code} tempBytes=${temporaryBytes}`
                + ` cause=${error instanceof Error ? error.message : String(error)}`,
            );
            throw normalized;
        }

        try {
            return await this.withSessionLock(uploadId, async () => {
                const session = this.getSession(uploadId);
                isActiveSession(session, this.now());
                const latestExpectedBytes = expectedPartBytes(session, partNumber);
                if (latestExpectedBytes !== streamed.size) {
                    throw new UploadSessionError("PART_SIZE_MISMATCH", "Uploaded part size does not match the persisted session.", 400);
                }
                return this.commitPart(session, partNumber, temporaryPath, streamed, startedAt);
            });
        } catch (error) {
            fs.rmSync(temporaryPath, { force: true });
            if (error instanceof UploadSessionError && error.code === "PART_CONFLICT") {
                this.logPartError("conflict", startingSession, partNumber, error.code);
            } else if (error instanceof UploadSessionError) {
                this.logPartError("failed", startingSession, partNumber, error.code);
            }
            throw error;
        }
    }

    async cancelSession(uploadId: string): Promise<UploadSessionRecord> {
        return this.withSessionLock(uploadId, async () => {
            const session = this.getSession(uploadId);
            if (session.status === "complete") {
                throw new UploadSessionError(
                    "UPLOAD_COMPLETE",
                    "A completed upload session cannot delete its permanent project file.",
                    409,
                );
            }
            if (session.status === "cancelled" || session.status === "expired") return session;
            const updated: UploadSessionRecord = {
                ...session,
                status: "cancelled",
                parts: [],
                receivedBytes: 0,
                updatedAt: this.now().toISOString(),
                cancelRequested: true,
            };
            this.repository.save(updated);
            this.repository.removeTemporaryData(uploadId);
            this.log("cancelled", updated);
            return updated;
        });
    }

    private async commitPart(
        session: UploadSessionRecord,
        partNumber: number,
        temporaryPath: string,
        streamed: { size: number; sha256: string },
        startedAt: number,
    ): Promise<UploadPartResult> {
        const existingPart = session.parts.find((part) => part.partNumber === partNumber);
        const committedPath = this.repository.getPartPath(session.uploadId, partNumber);
        if (existingPart) {
            if (!fs.existsSync(committedPath) || this.fileSize(committedPath) !== existingPart.size) {
                throw new UploadSessionError(
                    "PART_STORAGE_INCONSISTENT",
                    "The upload session manifest and committed part storage disagree.",
                    500,
                    true,
                );
            }
            if (existingPart.size !== streamed.size || existingPart.sha256 !== streamed.sha256) {
                throw new UploadSessionError("PART_CONFLICT", "A different immutable payload was already committed for this part.", 409);
            }
            this.logPart("idempotent", session, partNumber, `receivedBytes=${session.receivedBytes}`);
            return {
                uploadId: session.uploadId,
                partNumber,
                size: existingPart.size,
                sha256: existingPart.sha256,
                completedAt: existingPart.completedAt,
                alreadyPresent: true,
                receivedBytes: session.receivedBytes,
                totalBytes: session.totalBytes,
                status: "uploading",
            };
        }
        if (fs.existsSync(committedPath)) {
            throw new UploadSessionError(
                "PART_STORAGE_INCONSISTENT",
                "A committed part file exists without a matching session record.",
                500,
                true,
            );
        }

        const completedAt = this.now().toISOString();
        const part = { partNumber, size: streamed.size, sha256: streamed.sha256, completedAt };
        let committed = false;
        try {
            fs.renameSync(temporaryPath, committedPath);
            committed = true;
            const parts = [...session.parts, part].sort((left, right) => left.partNumber - right.partNumber);
            const receivedBytes = parts.reduce((sum, candidate) => sum + candidate.size, 0);
            if (!Number.isSafeInteger(receivedBytes) || receivedBytes > session.totalBytes) {
                throw new UploadSessionError("PART_SIZE_MISMATCH", "Committed part sizes exceed the upload total.", 400);
            }
            const now = this.now();
            const updated: UploadSessionRecord = {
                ...session,
                status: "uploading",
                parts,
                receivedBytes,
                updatedAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + this.expiryMs).toISOString(),
            };
            this.repository.save(updated);
            this.logPart(
                "complete",
                updated,
                partNumber,
                `actualBytes=${part.size} sha256=${part.sha256} elapsedMs=${Date.now() - startedAt}`
                + ` receivedBytes=${updated.receivedBytes}/${updated.totalBytes}`,
            );
            return {
                uploadId: updated.uploadId,
                partNumber,
                size: part.size,
                sha256: part.sha256,
                completedAt,
                alreadyPresent: false,
                receivedBytes: updated.receivedBytes,
                totalBytes: updated.totalBytes,
                status: "uploading",
            };
        } catch (error) {
            if (committed) {
                try {
                    fs.rmSync(committedPath, { force: true });
                } catch (cleanupError) {
                    this.logger.error(
                        `[Upload part cleanup failed] uploadId=${session.uploadId}`
                        + ` partNumber=${partNumber} error=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                    );
                }
            }
            throw error;
        }
    }

    private async streamPartToTemporaryFile(
        body: Readable,
        temporaryPath: string,
        expectedBytes: number,
    ): Promise<{ size: number; sha256: string }> {
        let actualBytes = 0;
        const hash = createHash("sha256");
        const counter = new Transform({
            transform(chunk: Buffer | string, _encoding, callback) {
                const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
                actualBytes += bytes;
                if (actualBytes > expectedBytes) {
                    callback(new UploadSessionError("PART_SIZE_MISMATCH", "Part body exceeds its expected byte length.", 413));
                    return;
                }
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(body, counter, fs.createWriteStream(temporaryPath, { flags: "wx" }));
        if (actualBytes !== expectedBytes) {
            throw new UploadSessionError(
                "PART_SIZE_MISMATCH",
                `Part body contained ${actualBytes} bytes; expected ${expectedBytes}.`,
                400,
            );
        }
        return { size: actualBytes, sha256: hash.digest("hex") };
    }

    private fsyncPartFile(filePath: string): void {
        const descriptor = fs.openSync(filePath, "r+");
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }

    private fileSize(filePath: string): number {
        try {
            return fs.statSync(filePath).size;
        } catch {
            return 0;
        }
    }

    private isAborted(body: Readable, error: unknown): boolean {
        const candidate = body as Readable & { aborted?: boolean };
        return candidate.aborted === true
            || (error instanceof Error && ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes((error as NodeJS.ErrnoException).code ?? ""));
    }

    private async withSessionLock<T>(uploadId: string, action: () => Promise<T>): Promise<T> {
        const previous = this.sessionLockTails.get(uploadId) ?? Promise.resolve();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        this.sessionLockTails.set(uploadId, tail);
        await previous;
        try {
            return await action();
        } finally {
            release?.();
            if (this.sessionLockTails.get(uploadId) === tail) this.sessionLockTails.delete(uploadId);
        }
    }

    private logPart(event: string, session: UploadSessionRecord, partNumber: number, details: string): void {
        this.logger.info(
            `[Upload part ${event}] uploadId=${session.uploadId}`
            + ` projectId=${session.projectId}`
            + ` partNumber=${partNumber}`
            + ` ${details}`,
        );
    }

    private logPartError(event: string, session: UploadSessionRecord, partNumber: number, details: string): void {
        this.logger.error(
            `[Upload part ${event}] uploadId=${session.uploadId}`
            + ` projectId=${session.projectId}`
            + ` partNumber=${partNumber}`
            + ` ${details}`,
        );
    }

    private log(event: string, session: UploadSessionRecord): void {
        this.logger.info(
            `[Upload session ${event}] uploadId=${session.uploadId}`
            + ` projectId=${session.projectId}`
            + ` totalBytes=${session.totalBytes}`
            + ` totalParts=${session.totalParts}`
            + ` chunkSize=${session.chunkSize}`
            + ` status=${session.status}`,
        );
    }
}
