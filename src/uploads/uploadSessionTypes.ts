export const UPLOAD_SESSION_VERSION = 1 as const;
export const DEFAULT_UPLOAD_CHUNK_SIZE_BYTES = 64 * 1024 ** 2;
export const DEFAULT_MAX_RESUMABLE_UPLOAD_BYTES = 50 * 1024 ** 3;
export const UPLOAD_SESSION_EXPIRY_MS = 72 * 60 * 60 * 1000;

export const uploadFileKinds = ["structured-e57", "ifc", "point-cloud"] as const;
export type UploadFileKind = typeof uploadFileKinds[number];

export const uploadSessionStatuses = [
    "created",
    "uploading",
    "finalizing",
    "complete",
    "failed",
    "cancelled",
    "expired",
] as const;
export type UploadSessionStatus = typeof uploadSessionStatuses[number];

export interface UploadPartRecord {
    partNumber: number;
    size: number;
    sha256: string;
}

/**
 * Durable internal upload-session representation. The API derives
 * uploadedParts from parts so part identity is stored only once.
 */
export interface UploadSessionRecord {
    version: typeof UPLOAD_SESSION_VERSION;
    uploadId: string;
    projectId: string;
    filename: string;
    normalizedExtension: string;
    mimeType: string;
    fileKind: UploadFileKind;
    operation: "create" | "replace";
    replaceFileId?: string;
    reservedFileId: string;
    totalBytes: number;
    chunkSize: number;
    totalParts: number;
    receivedBytes: number;
    expectedSha256?: string;
    finalSha256?: string;
    idempotencyKey?: string;
    status: UploadSessionStatus;
    parts: UploadPartRecord[];
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    cancelRequested?: boolean;
    finalAsset?: { projectId: string; fileId: string; revision: number };
    error?: { code: string; message: string; retryable: boolean };
}

export interface UploadSessionResponse {
    uploadId: string;
    projectId: string;
    filename: string;
    mimeType: string;
    fileKind: UploadFileKind;
    totalBytes: number;
    receivedBytes: number;
    chunkSize: number;
    totalParts: number;
    uploadedParts: number[];
    status: UploadSessionStatus;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    finalSha256?: string;
    finalAsset?: { projectId: string; fileId: string; revision: number };
    error?: { code: string; message: string; retryable: boolean };
}

export function toUploadSessionResponse(session: UploadSessionRecord): UploadSessionResponse {
    return {
        uploadId: session.uploadId,
        projectId: session.projectId,
        filename: session.filename,
        mimeType: session.mimeType,
        fileKind: session.fileKind,
        totalBytes: session.totalBytes,
        receivedBytes: session.receivedBytes,
        chunkSize: session.chunkSize,
        totalParts: session.totalParts,
        uploadedParts: session.parts.map(({ partNumber }) => partNumber).sort((left, right) => left - right),
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        expiresAt: session.expiresAt,
        ...(session.finalSha256 ? { finalSha256: session.finalSha256 } : {}),
        ...(session.finalAsset ? { finalAsset: session.finalAsset } : {}),
        ...(session.error ? { error: session.error } : {}),
    };
}
