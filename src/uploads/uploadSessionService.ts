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
    | "UPLOAD_INCOMPLETE"
    | "FINALIZATION_NOT_ALLOWED"
    | "PART_INTEGRITY_MISMATCH"
    | "INSUFFICIENT_DISK_SPACE"
    | "FINAL_SIZE_MISMATCH"
    | "FINAL_HASH_MISMATCH"
    | "FINALIZATION_IO_FAILED"
    | "FINAL_PROMOTION_FAILED"
    | "FINAL_ARTIFACT_INCONSISTENT"
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
    getFreeDiskBytes?: (directory: string) => number;
    finalizationFaultInjector?: (stage: "before-assembly" | "during-assembly" | "before-promotion", processedBytes: number) => void;
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

export interface CompleteUploadResult {
    session: UploadSessionRecord;
    alreadyComplete: boolean;
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

export function requiredFinalizationFreeBytes(totalBytes: number): number {
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
        throw new UploadSessionError("INVALID_FILE_SIZE", "Finalization size must be a positive safe integer.", 400);
    }
    const safetyMargin = Math.max(512 * 1024 ** 2, Math.ceil(totalBytes * 0.05));
    return totalBytes + safetyMargin;
}

export function finalizationPercent(processedBytes: number, totalBytes: number): number {
    if (!Number.isSafeInteger(processedBytes) || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return 0;
    return Math.min(100, (processedBytes / totalBytes) * 100);
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
    private readonly getFreeDiskBytes: (directory: string) => number;
    private readonly finalizationFaultInjector?: UploadSessionServiceOptions["finalizationFaultInjector"];
    private readonly sessionLockTails = new Map<string, Promise<void>>();
    private readonly finalizationTasks = new Map<string, Promise<void>>();

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
        this.getFreeDiskBytes = options.getFreeDiskBytes ?? ((directory) => {
            const statistics = fs.statfsSync(directory);
            return statistics.bavail * statistics.bsize;
        });
        this.finalizationFaultInjector = options.finalizationFaultInjector;
        if (!Number.isSafeInteger(this.chunkSize) || this.chunkSize <= 0
            || !Number.isSafeInteger(this.maxUploadBytes) || this.maxUploadBytes <= 0
            || !Number.isSafeInteger(this.expiryMs) || this.expiryMs <= 0) {
            throw new Error("Upload session service limits must be positive safe integers.");
        }
        const recoverable = this.repository.listFinalizingUploadIds();
        if (recoverable.length > 0) {
            this.logger.info(`[Upload finalize recovery discovered] count=${recoverable.length} strategy=lazy-restart-from-zero`);
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
        try {
            this.repository.assertFinalizedArtifactStorage(session);
        } catch (error) {
            this.logger.error(
                `[Upload finalized artifact inconsistent] uploadId=${uploadId}`
                + ` error=${error instanceof Error ? error.message : String(error)}`,
            );
            throw new UploadSessionError(
                "FINAL_ARTIFACT_INCONSISTENT",
                "The completed upload artifact does not match its durable manifest.",
                500,
                true,
            );
        }
        // Reads are deliberately non-mutating. R2B.6 owns the durable
        // transition to expired; clients can already observe expiresAt.
        this.log("loaded", session);
        return session;
    }

    getSessionStatus(uploadId: string): UploadSessionRecord {
        const session = this.getSession(uploadId);
        if (session.status === "finalizing") this.ensureFinalizationTask(uploadId, true);
        return session;
    }

    async completeSession(uploadId: string): Promise<CompleteUploadResult> {
        const normalizedUploadId = requiredString(uploadId, "uploadId");
        let result!: CompleteUploadResult;
        await this.withSessionLock(normalizedUploadId, async () => {
            const session = this.getSession(normalizedUploadId);
            this.logger.info(
                `[Upload finalize request] uploadId=${session.uploadId} projectId=${session.projectId}`
                + ` totalBytes=${session.totalBytes} totalParts=${session.totalParts} status=${session.status}`,
            );
            if (session.status === "complete") {
                result = { session, alreadyComplete: true };
                return;
            }
            if (session.status === "cancelled") {
                throw new UploadSessionError("UPLOAD_CANCELLED", "The upload session was cancelled.", 409);
            }
            if (session.status === "expired" || this.now().getTime() >= Date.parse(session.expiresAt)) {
                throw new UploadSessionError("UPLOAD_EXPIRED", "The upload session has expired.", 410);
            }
            if (session.status === "failed" && !session.error?.retryable) {
                throw new UploadSessionError(
                    "FINALIZATION_NOT_ALLOWED",
                    "The upload failed with a non-retryable integrity error.",
                    409,
                );
            }
            if (session.status === "finalizing") {
                result = { session, alreadyComplete: false };
                return;
            }
            if (session.status !== "created" && session.status !== "uploading" && session.status !== "failed") {
                throw new UploadSessionError("FINALIZATION_NOT_ALLOWED", `Status ${session.status} cannot be finalized.`, 409);
            }
            this.assertCompletePartSet(session);
            const timestamp = this.now().toISOString();
            const {
                error: _previousError,
                finalBytes: _previousFinalBytes,
                finalSha256: _previousFinalSha256,
                finalizedAt: _previousFinalizedAt,
                finalizedArtifactName: _previousFinalizedArtifactName,
                ...sessionWithoutFinalResult
            } = session;
            const finalizing: UploadSessionRecord = {
                ...sessionWithoutFinalResult,
                status: "finalizing",
                finalizationStartedAt: timestamp,
                finalizationUpdatedAt: timestamp,
                updatedAt: timestamp,
            };
            this.repository.save(finalizing);
            result = { session: finalizing, alreadyComplete: false };
        });
        if (!result.alreadyComplete) this.ensureFinalizationTask(normalizedUploadId, result.session.status === "finalizing");
        return result;
    }

    async waitForFinalization(uploadId: string): Promise<UploadSessionRecord> {
        const session = this.getSession(uploadId);
        if (session.status === "finalizing") await this.ensureFinalizationTask(uploadId, true);
        return this.getSession(uploadId);
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
            if (session.status === "finalizing") {
                throw new UploadSessionError(
                    "UPLOAD_NOT_ACTIVE",
                    "A finalizing upload cannot be cancelled while assembly is active.",
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

    private assertCompletePartSet(session: UploadSessionRecord): void {
        if (session.totalParts <= 0
            || session.parts.length !== session.totalParts
            || session.receivedBytes !== session.totalBytes) {
            throw new UploadSessionError("UPLOAD_INCOMPLETE", "All upload parts must be present before finalization.", 409);
        }
        for (let partNumber = 0; partNumber < session.totalParts; partNumber += 1) {
            const part = session.parts[partNumber];
            if (!part || part.partNumber !== partNumber || part.size !== expectedPartBytes(session, partNumber)) {
                throw new UploadSessionError("UPLOAD_INCOMPLETE", `Upload part ${partNumber} is missing or invalid.`, 409);
            }
        }
        try {
            this.repository.assertCommittedPartStorage(session);
        } catch {
            throw new UploadSessionError(
                "PART_STORAGE_INCONSISTENT",
                "The upload session manifest and committed part storage disagree.",
                500,
                true,
            );
        }
    }

    private ensureFinalizationTask(uploadId: string, recovery: boolean): Promise<void> {
        const existing = this.finalizationTasks.get(uploadId);
        if (existing) return existing;
        if (recovery) {
            this.logger.info(`[Upload finalize recovery] uploadId=${uploadId} action=reconcile-or-restart-from-zero`);
        }
        const task = this.runFinalization(uploadId)
            .catch((error) => {
                // The HTTP request does not own this background task. If even
                // failure-state persistence is unavailable, leave the durable
                // finalizing intent for the next lazy recovery attempt.
                this.logger.error(
                    `[Upload finalize background failure] uploadId=${uploadId}`
                    + ` error=${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => {
                if (this.finalizationTasks.get(uploadId) === task) this.finalizationTasks.delete(uploadId);
            });
        this.finalizationTasks.set(uploadId, task);
        return task;
    }

    private async runFinalization(uploadId: string): Promise<void> {
        const startedAt = Date.now();
        let processedBytes = 0;
        let stage = "prepare";
        try {
            const session = this.repository.get(uploadId);
            if (!session || session.status !== "finalizing") return;
            this.assertCompletePartSet(session);
            this.repository.prepareFinalizationDirectories(uploadId);
            const temporaryPath = this.repository.getAssemblyTemporaryPath(uploadId);
            const finalPath = this.repository.getFinalizedArtifactPath(session);

            if (fs.existsSync(finalPath)) {
                stage = "reconcile-promoted-artifact";
                const [reconciled, authoritative] = await Promise.all([
                    this.hashFile(finalPath),
                    this.hashAuthoritativeParts(session),
                ]);
                if (reconciled.size === session.totalBytes
                    && authoritative.size === session.totalBytes
                    && reconciled.sha256 === authoritative.sha256
                    && (!session.expectedSha256 || reconciled.sha256 === session.expectedSha256)) {
                    await this.persistCompleted(session, reconciled.size, reconciled.sha256);
                    this.logger.info(`[Upload finalize recovery] uploadId=${uploadId} action=reconciled-promoted-artifact`);
                    return;
                }
                fs.rmSync(finalPath, { force: true });
            }

            // Recovery always discards an untrusted partial assembly and starts from part zero.
            fs.rmSync(temporaryPath, { force: true });
            const availableDisk = this.getFreeDiskBytes(this.repository.getSessionDirectory(uploadId));
            const requiredDisk = requiredFinalizationFreeBytes(session.totalBytes);
            if (!Number.isSafeInteger(availableDisk) || availableDisk < requiredDisk) {
                throw new UploadSessionError(
                    "INSUFFICIENT_DISK_SPACE",
                    `Finalization requires at least ${requiredDisk} free bytes; ${availableDisk} are available.`,
                    507,
                    true,
                );
            }
            this.logger.info(
                `[Upload finalize start] uploadId=${uploadId} availableDisk=${availableDisk}`
                + ` expectedBytes=${session.totalBytes}`,
            );
            this.finalizationFaultInjector?.("before-assembly", 0);
            stage = "assemble";
            const hash = createHash("sha256");
            const output = await fs.promises.open(temporaryPath, "wx");
            let lastProgressAt = Date.now();
            try {
                for (const part of session.parts) {
                    const partHash = createHash("sha256");
                    let partBytes = 0;
                    const input = fs.createReadStream(this.repository.getPartPath(uploadId, part.partNumber));
                    for await (const rawChunk of input) {
                        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                        partBytes += chunk.length;
                        processedBytes += chunk.length;
                        partHash.update(chunk);
                        hash.update(chunk);
                        let offset = 0;
                        while (offset < chunk.length) {
                            const write = await output.write(chunk, offset, chunk.length - offset);
                            offset += write.bytesWritten;
                        }
                        this.finalizationFaultInjector?.("during-assembly", processedBytes);
                        const now = Date.now();
                        if (now - lastProgressAt >= 30_000) {
                            const seconds = Math.max(0.001, (now - startedAt) / 1000);
                            this.logger.info(
                                `[Upload finalize progress] uploadId=${uploadId} partsProcessed=${part.partNumber}`
                                + ` bytesAssembled=${processedBytes} percent=${finalizationPercent(processedBytes, session.totalBytes).toFixed(2)}`
                                + ` throughputMBps=${(processedBytes / 1024 ** 2 / seconds).toFixed(2)}`,
                            );
                            lastProgressAt = now;
                        }
                    }
                    if (partBytes !== part.size || partHash.digest("hex") !== part.sha256) {
                        throw new UploadSessionError(
                            "PART_INTEGRITY_MISMATCH",
                            `Upload part ${part.partNumber} no longer matches its persisted size and SHA-256.`,
                            422,
                        );
                    }
                }
                await output.sync();
            } finally {
                await output.close();
            }
            if (processedBytes !== session.totalBytes) {
                throw new UploadSessionError(
                    "FINAL_SIZE_MISMATCH",
                    `Assembled ${processedBytes} bytes; expected ${session.totalBytes}.`,
                    422,
                );
            }
            const finalSha256 = hash.digest("hex");
            if (session.expectedSha256 && finalSha256 !== session.expectedSha256) {
                throw new UploadSessionError("FINAL_HASH_MISMATCH", "The assembled file SHA-256 does not match expectedSha256.", 422);
            }
            this.finalizationFaultInjector?.("before-promotion", processedBytes);
            stage = "promote";
            try {
                fs.renameSync(temporaryPath, finalPath);
            } catch (error) {
                throw new UploadSessionError(
                    "FINAL_PROMOTION_FAILED",
                    `The finalized upload artifact could not be promoted: ${error instanceof Error ? error.message : String(error)}`,
                    500,
                    true,
                );
            }
            await this.persistCompleted(session, processedBytes, finalSha256);
            const elapsedMs = Date.now() - startedAt;
            this.logger.info(
                `[Upload finalize complete] uploadId=${uploadId} finalBytes=${processedBytes}`
                + ` finalSha256=${finalSha256} elapsedMs=${elapsedMs}`
                + ` averageMBps=${(processedBytes / 1024 ** 2 / Math.max(0.001, elapsedMs / 1000)).toFixed(2)}`,
            );
        } catch (error) {
            fs.rmSync(this.repository.getAssemblyTemporaryPath(uploadId), { force: true });
            const normalized = this.normalizeFinalizationError(error);
            await this.persistFinalizationFailure(uploadId, normalized);
            this.logger.error(
                `[Upload finalize failure] uploadId=${uploadId} code=${normalized.code}`
                + ` stage=${stage} processedBytes=${processedBytes} error=${normalized.message}`,
            );
        }
    }

    private async hashFile(filePath: string): Promise<{ size: number; sha256: string }> {
        const hash = createHash("sha256");
        let size = 0;
        for await (const rawChunk of fs.createReadStream(filePath)) {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            size += chunk.length;
            hash.update(chunk);
        }
        return { size, sha256: hash.digest("hex") };
    }

    private async hashAuthoritativeParts(session: UploadSessionRecord): Promise<{ size: number; sha256: string }> {
        const finalHash = createHash("sha256");
        let totalSize = 0;
        for (const part of session.parts) {
            const partHash = createHash("sha256");
            let partSize = 0;
            for await (const rawChunk of fs.createReadStream(this.repository.getPartPath(session.uploadId, part.partNumber))) {
                const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                partSize += chunk.length;
                totalSize += chunk.length;
                partHash.update(chunk);
                finalHash.update(chunk);
            }
            if (partSize !== part.size || partHash.digest("hex") !== part.sha256) {
                throw new UploadSessionError(
                    "PART_INTEGRITY_MISMATCH",
                    `Upload part ${part.partNumber} no longer matches its persisted size and SHA-256.`,
                    422,
                );
            }
        }
        return { size: totalSize, sha256: finalHash.digest("hex") };
    }

    private async persistCompleted(session: UploadSessionRecord, finalBytes: number, finalSha256: string): Promise<void> {
        await this.withSessionLock(session.uploadId, async () => {
            const current = this.repository.get(session.uploadId);
            if (!current || current.status === "complete") return;
            if (current.status !== "finalizing") {
                throw new UploadSessionError("FINALIZATION_NOT_ALLOWED", "Finalization state changed before completion.", 409);
            }
            const timestamp = this.now().toISOString();
            const { error: _previousError, ...currentWithoutError } = current;
            this.repository.save({
                ...currentWithoutError,
                status: "complete",
                finalBytes,
                finalSha256,
                finalizedAt: timestamp,
                finalizedArtifactName: this.repository.getFinalizedArtifactName(current),
                finalizationUpdatedAt: timestamp,
                updatedAt: timestamp,
            });
        });
    }

    private async persistFinalizationFailure(uploadId: string, error: UploadSessionError): Promise<void> {
        await this.withSessionLock(uploadId, async () => {
            const current = this.repository.get(uploadId);
            if (!current || current.status !== "finalizing") return;
            const timestamp = this.now().toISOString();
            this.repository.save({
                ...current,
                status: "failed",
                finalizationUpdatedAt: timestamp,
                updatedAt: timestamp,
                error: { code: error.code, message: error.message, retryable: error.retryable },
            });
        });
    }

    private normalizeFinalizationError(error: unknown): UploadSessionError {
        if (error instanceof UploadSessionError) return error;
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code === "ENOSPC") {
            return new UploadSessionError("INSUFFICIENT_DISK_SPACE", "Disk space was exhausted during finalization.", 507, true);
        }
        return new UploadSessionError(
            "FINALIZATION_IO_FAILED",
            `Finalization I/O failed: ${error instanceof Error ? error.message : String(error)}`,
            500,
            true,
        );
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
