import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectRecord } from "../projectStore.js";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import { UploadSessionService } from "./uploadSessionService.js";
import type { UploadSessionRecord } from "./uploadSessionTypes.js";

const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const committedPartPattern = /^\d{8}\.part$/;
const temporaryPartPattern = /^\.\d{8}\.[0-9a-f-]{36}\.tmp$/i;
const temporaryManifestPattern = /^session\.json\.[0-9a-f-]{36}\.tmp$/i;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface UploadCleanupSummary {
    scanned: number;
    expired: number;
    cleaned: number;
    orphanTemps: number;
    bytesReclaimed: number;
    failures: number;
}

export interface UploadSessionCleanupOptions {
    repository: UploadSessionRepository;
    sessions: UploadSessionService;
    getProject(projectId: string): ProjectRecord | undefined;
    getProjectDirectory(projectId: string): string;
    now?: () => Date;
    logger?: Pick<Console, "info" | "warn" | "error">;
}

function ageMs(now: Date, timestamp: string): number {
    return now.getTime() - Date.parse(timestamp);
}

function expectedKind(session: UploadSessionRecord): "ifc" | "structured-e57" | "point-cloud" {
    return session.fileKind;
}

/** Only session-owned files are ever removed; project directories are read-only. */
export class UploadSessionCleanupService {
    private readonly now: () => Date;
    private readonly logger: Pick<Console, "info" | "warn" | "error">;
    private running: Promise<UploadCleanupSummary> | undefined;

    constructor(private readonly options: UploadSessionCleanupOptions) {
        this.now = options.now ?? (() => new Date());
        this.logger = options.logger ?? console;
    }

    sweep(): Promise<UploadCleanupSummary> {
        if (this.running) return this.running;
        const task = this.runSweep().finally(() => {
            if (this.running === task) this.running = undefined;
        });
        this.running = task;
        return task;
    }

    private async runSweep(): Promise<UploadCleanupSummary> {
        const result: UploadCleanupSummary = {
            scanned: 0, expired: 0, cleaned: 0, orphanTemps: 0, bytesReclaimed: 0, failures: 0,
        };
        const root = this.options.repository.getRootDirectory();
        this.logger.info("[Upload cleanup start]");
        if (!fs.existsSync(root)) {
            this.logger.info("[Upload cleanup complete] scanned=0 expired=0 cleaned=0 orphanTemps=0 bytesReclaimed=0 failures=0");
            return result;
        }
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (!uploadIdPattern.test(entry.name)) {
                this.logger.warn(`[Upload cleanup skipped] category=unknown-directory name=${entry.name}`);
                continue;
            }
            result.scanned += 1;
            try {
                await this.options.sessions.withMaintenanceLock(entry.name, async () => {
                    let session: UploadSessionRecord | undefined;
                    try { session = this.options.repository.get(entry.name); } catch (error) {
                        this.logger.warn(`[Upload cleanup skipped] uploadId=${entry.name} reason=invalid-manifest`
                            + ` error=${error instanceof Error ? error.message : String(error)}`);
                        return;
                    }
                    if (!session) {
                        this.logger.warn(`[Upload cleanup skipped] uploadId=${entry.name} reason=missing-manifest`);
                        return;
                    }
                    if (this.options.sessions.hasActiveTransfer(entry.name)) {
                        this.logger.info(`[Upload cleanup skipped] uploadId=${entry.name} reason=active-transfer`);
                        return;
                    }
                    this.cleanSession(session, result);
                });
            } catch (error) {
                result.failures += 1;
                this.logger.error(`[Upload cleanup failure] uploadId=${entry.name} error=${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.logger.info(
            `[Upload cleanup complete] scanned=${result.scanned} expired=${result.expired}`
            + ` cleaned=${result.cleaned} orphanTemps=${result.orphanTemps}`
            + ` bytesReclaimed=${result.bytesReclaimed} failures=${result.failures}`,
        );
        return result;
    }

    private cleanSession(session: UploadSessionRecord, result: UploadCleanupSummary): void {
        const now = this.now();
        let current = session;
        if ((current.status === "created" || current.status === "uploading")
            && now.getTime() > Date.parse(current.expiresAt)) {
            current = { ...current, status: "expired", updatedAt: now.toISOString() };
            this.options.repository.save(current); // Durable tombstone before deleting bytes.
            result.expired += 1;
            this.logger.info(`[Upload session expired] uploadId=${current.uploadId} projectId=${current.projectId}`
                + ` previousStatus=${session.status} ageMs=${ageMs(now, session.updatedAt)}`);
        }

        let eligible = current.status === "expired" || current.status === "cancelled";
        if (current.status === "failed" && current.error?.retryable === false
            && ageMs(now, current.updatedAt) >= FAILED_RETENTION_MS) eligible = true;
        if (current.status === "complete") eligible = this.hasDurableCanonicalSource(current);

        if (eligible) {
            if (!current.temporaryDataCleanupStartedAt) {
                current = { ...current, temporaryDataCleanupStartedAt: now.toISOString(), updatedAt: now.toISOString() };
                this.options.repository.save(current);
            }
            const reclaimed = this.removeKnownSessionBytes(current);
            result.bytesReclaimed += reclaimed;
            if (!current.temporaryDataCleanedAt) {
                current = { ...current, temporaryDataCleanedAt: now.toISOString(), updatedAt: now.toISOString() };
                this.options.repository.save(current);
                result.cleaned += 1;
                this.logger.info(`[Upload session temp cleaned] uploadId=${current.uploadId} bytesReclaimed=${reclaimed}`);
            }
        } else if (current.status === "complete" && !current.projectFileId) {
            this.logger.info(`[Upload cleanup skipped] uploadId=${current.uploadId} reason=awaiting-project-registration`);
        }

        if (current.status !== "finalizing" && (current.status !== "failed" || eligible)) {
            result.bytesReclaimed += this.removeStaleOrphanTemps(current, now, result);
        }
        if (eligible && current.temporaryDataCleanedAt
            && ageMs(now, current.temporaryDataCleanedAt) >= TOMBSTONE_RETENTION_MS) {
            this.purgeEmptyTombstone(current);
        }
    }

    private hasDurableCanonicalSource(session: UploadSessionRecord): boolean {
        if (!session.projectFileId || session.projectFileId !== session.reservedFileId
            || session.finalBytes !== session.totalBytes || !session.finalSha256) return false;
        const project = this.options.getProject(session.projectId);
        const record = project?.files.find((file) => file.id === session.projectFileId);
        if (!record || record.originalName !== session.filename || record.kind !== expectedKind(session)) return false;
        const source = path.join(this.options.getProjectDirectory(session.projectId), "uploads",
            `${session.reservedFileId}${session.normalizedExtension}`);
        try {
            const stat = fs.lstatSync(source);
            return stat.isFile() && stat.size === session.finalBytes;
        } catch {
            return false;
        }
    }

    private removeKnownSessionBytes(session: UploadSessionRecord): number {
        const directory = this.options.repository.getSessionDirectory(session.uploadId);
        let bytes = 0;
        const parts = path.join(directory, "parts");
        this.assertRealDirectory(parts);
        this.assertRealDirectory(path.join(directory, "finalizing"));
        this.assertRealDirectory(path.join(directory, "finalized"));
        if (fs.existsSync(parts)) {
            for (const entry of fs.readdirSync(parts, { withFileTypes: true })) {
                if (entry.isFile() && committedPartPattern.test(entry.name)) {
                    bytes += this.unlinkKnownFile(path.join(parts, entry.name));
                }
            }
        }
        bytes += this.unlinkKnownFile(this.options.repository.getAssemblyTemporaryPath(session.uploadId));
        bytes += this.unlinkKnownFile(this.options.repository.getFinalizedArtifactPath(session));
        this.removeEmptyDirectory(parts);
        this.removeEmptyDirectory(path.join(directory, "finalizing"));
        this.removeEmptyDirectory(path.join(directory, "finalized"));
        return bytes;
    }

    private removeStaleOrphanTemps(session: UploadSessionRecord, now: Date, result: UploadCleanupSummary): number {
        const directory = this.options.repository.getSessionDirectory(session.uploadId);
        let bytes = 0;
        for (const [folder, pattern] of [[directory, temporaryManifestPattern],
            [path.join(directory, "parts"), temporaryPartPattern]] as const) {
            if (!fs.existsSync(folder)) continue;
            this.assertRealDirectory(folder);
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                if (!entry.isFile() || !pattern.test(entry.name)) continue;
                const candidate = path.join(folder, entry.name);
                const stat = fs.statSync(candidate);
                if (now.getTime() - stat.mtimeMs < ORPHAN_AGE_MS) continue;
                bytes += this.unlinkKnownFile(candidate);
                result.orphanTemps += 1;
                this.logger.info(`[Upload orphan temp cleaned] uploadId=${session.uploadId} category=${folder === directory ? "manifest" : "part"}`
                    + ` ageMs=${Math.round(now.getTime() - stat.mtimeMs)} bytes=${stat.size}`);
            }
        }
        if (session.status !== "complete" && session.status !== "finalizing") {
            this.assertRealDirectory(path.join(directory, "finalizing"));
            const assembly = this.options.repository.getAssemblyTemporaryPath(session.uploadId);
            if (fs.existsSync(assembly)) {
                const stat = fs.statSync(assembly);
                if (now.getTime() - stat.mtimeMs >= ORPHAN_AGE_MS) {
                    bytes += this.unlinkKnownFile(assembly);
                    result.orphanTemps += 1;
                    this.logger.info(`[Upload orphan temp cleaned] uploadId=${session.uploadId} category=assembly`
                        + ` ageMs=${Math.round(now.getTime() - stat.mtimeMs)} bytes=${stat.size}`);
                }
            }
        }
        return bytes;
    }

    private unlinkKnownFile(filePath: string): number {
        try {
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile()) return 0;
            fs.unlinkSync(filePath);
            return stat.size;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
            throw error;
        }
    }

    private assertRealDirectory(directory: string): void {
        try {
            if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Unsafe upload session directory: ${directory}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }

    private removeEmptyDirectory(directory: string): void {
        try { fs.rmdirSync(directory); } catch (error) {
            if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
    }

    private purgeEmptyTombstone(session: UploadSessionRecord): void {
        const directory = this.options.repository.getSessionDirectory(session.uploadId);
        for (const child of ["parts", "incoming", "finalizing", "finalized"]) {
            this.removeEmptyDirectory(path.join(directory, child));
        }
        const remaining = fs.readdirSync(directory);
        if (remaining.length !== 1 || remaining[0] !== "session.json") {
            this.logger.warn(`[Upload cleanup skipped] uploadId=${session.uploadId} reason=unknown-session-data`);
            return;
        }
        fs.unlinkSync(path.join(directory, "session.json"));
        fs.rmdirSync(directory);
        this.logger.info(`[Upload session tombstone purged] uploadId=${session.uploadId}`);
    }
}
