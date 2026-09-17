import * as fs from "node:fs";

/**
 * Upload limits are deliberately expressed as JavaScript numbers. 2 GiB and
 * 20 GiB are well below Number.MAX_SAFE_INTEGER and must never be coerced to
 * a signed 32-bit integer with bitwise operators.
 */
export const UPLOAD_FILE_SIZE_LIMIT_BYTES = 20 * 1024 ** 3;
export const LARGE_UPLOAD_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
export const UPLOAD_PROGRESS_INTERVAL_MS = 30 * 1000;

export interface UploadDiagnosticsContext {
    readonly requestId: string;
    readonly route: string;
    readonly startedAt: number;
    readonly contentLength?: number;
    readonly tempPaths: string[];
    receivedBytes: number;
    clientAborted: boolean;
    requestComplete: boolean;
    uploadCompleted: boolean;
    progressTimer?: NodeJS.Timeout;
}

export interface CleanupResult {
    removed: string[];
    failed: Array<{ path: string; error: string }>;
}

export function parseContentLength(value: string | string[] | undefined): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function uploadPercent(receivedBytes: number, expectedBytes: number | undefined): number | undefined {
    if (!expectedBytes || expectedBytes <= 0) return undefined;
    return Math.min(100, (receivedBytes / expectedBytes) * 100);
}

export function cleanupUploadFiles(paths: ReadonlyArray<string>): CleanupResult {
    const removed: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const filePath of new Set(paths)) {
        try {
            fs.rmSync(filePath, { force: true });
            removed.push(filePath);
        } catch (error) {
            failed.push({ path: filePath, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { removed, failed };
}

