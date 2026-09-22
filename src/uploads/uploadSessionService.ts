import * as path from "node:path";
import { randomUUID } from "node:crypto";
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
    | "UPLOAD_COMPLETE";

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
    logger?: Pick<Console, "info">;
}

const extensionByKind: Record<UploadFileKind, ReadonlySet<string>> = {
    "structured-e57": new Set([".e57"]),
    ifc: new Set([".ifc"]),
    "point-cloud": new Set([".las", ".laz"]),
};

const sha256Pattern = /^[0-9a-f]{64}$/i;
const invalidWindowsFilenameCharacter = /[<>:"/\\|?*\u0000-\u001f]/;

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
    private readonly logger: Pick<Console, "info">;

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
        // Reads are deliberately non-mutating. R2B.6 owns the durable
        // transition to expired; clients can already observe expiresAt.
        this.log("loaded", session);
        return session;
    }

    cancelSession(uploadId: string): UploadSessionRecord {
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
            updatedAt: this.now().toISOString(),
            cancelRequested: true,
        };
        this.repository.save(updated);
        this.repository.removeTemporaryData(uploadId);
        this.log("cancelled", updated);
        return updated;
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
