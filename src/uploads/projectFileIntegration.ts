import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ProjectFileRecord, ProjectRecord } from "../projectStore.js";
import { UploadSessionRepository } from "./uploadSessionRepository.js";
import type { UploadIntegrationError, UploadSessionRecord } from "./uploadSessionTypes.js";

export interface ProjectFileIntegrationLogger {
    info(message: string): void;
    error(message: string): void;
}

export interface ProjectFileIntegrationOptions {
    repository: UploadSessionRepository;
    getProject(projectId: string): ProjectRecord | undefined;
    updateProject(projectId: string, update: (project: ProjectRecord) => void): ProjectRecord | undefined;
    getProjectDirectory(projectId: string): string;
    createProjectFileRecord(project: ProjectRecord, session: UploadSessionRecord): ProjectFileRecord;
    dispatchProjectFileProcessing(projectId: string, file: ProjectFileRecord, inputPath: string): boolean;
    now?: () => Date;
    logger?: ProjectFileIntegrationLogger;
}

type IntegrationSessionPatch = Omit<Partial<UploadSessionRecord>, "integrationError">
    & { integrationError?: UploadIntegrationError; clearIntegrationError?: boolean };

function canonicalSourcePath(projectDirectory: string, session: UploadSessionRecord): string {
    return path.join(projectDirectory, "uploads", `${session.reservedFileId}${session.normalizedExtension}`);
}

function integrationError(
    stage: UploadIntegrationError["stage"],
    error: unknown,
): UploadIntegrationError {
    return {
        stage,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
    };
}

/**
 * Bridges a verified resumable transport artifact into the existing permanent
 * project-file model. It deliberately knows nothing about E57 or IFC
 * conversion: the injected dispatcher remains the existing processing owner.
 */
export class ProjectFileIntegrationService {
    private readonly now: () => Date;
    private readonly logger: ProjectFileIntegrationLogger;
    private readonly tasks = new Map<string, Promise<void>>();

    constructor(private readonly options: ProjectFileIntegrationOptions) {
        this.now = options.now ?? (() => new Date());
        this.logger = options.logger ?? console;
    }

    ensure(uploadId: string, recovered = false): Promise<void> {
        const existing = this.tasks.get(uploadId);
        if (existing) return existing;
        const task = this.integrate(uploadId, recovered)
            .catch((error) => {
                // Transport remains complete even if downstream registration
                // needs a later retry. Persist a separate integration error.
                this.logger.error(
                    `[Upload integration failure] uploadId=${uploadId}`
                    + ` error=${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => {
                if (this.tasks.get(uploadId) === task) this.tasks.delete(uploadId);
            });
        this.tasks.set(uploadId, task);
        return task;
    }

    recoverCompleted(): void {
        const uploadIds = this.options.repository.listCompletedUploadIds();
        if (uploadIds.length > 0) {
            this.logger.info(`[Upload integration recovery discovered] count=${uploadIds.length}`);
        }
        uploadIds.forEach((uploadId) => { void this.ensure(uploadId, true); });
    }

    private async integrate(uploadId: string, recovered: boolean): Promise<void> {
        let session = this.requireCompleteSession(uploadId);
        const project = this.options.getProject(session.projectId);
        if (!project) {
            this.persistError(session, integrationError("register", new Error("Project no longer exists.")));
            return;
        }
        const projectDirectory = this.options.getProjectDirectory(session.projectId);
        const sourcePath = canonicalSourcePath(projectDirectory, session);

        this.logger.info(
            `[Upload integration start] uploadId=${session.uploadId} projectId=${session.projectId}`
            + ` reservedFileId=${session.reservedFileId} fileKind=${session.fileKind}`
            + ` finalBytes=${session.finalBytes}${recovered ? " recovered=true" : ""}`,
        );

        try {
            session = await this.adoptCanonicalSource(session, sourcePath);
        } catch (error) {
            this.persistError(session, integrationError("adopt", error));
            return;
        }

        let fileRecord: ProjectFileRecord | undefined;
        try {
            const updated = this.options.updateProject(session.projectId, (storedProject) => {
                const existing = storedProject.files.find((candidate) => candidate.id === session.reservedFileId);
                if (existing) {
                    fileRecord = existing;
                    return;
                }
                const record = this.options.createProjectFileRecord(storedProject, session);
                storedProject.files.push(record);
                fileRecord = record;
            });
            if (!updated || !fileRecord) throw new Error("Project no longer exists.");
            session = this.persist(session, {
                integrationStage: "registered",
                projectFileId: fileRecord.id,
                registeredAt: session.registeredAt ?? this.now().toISOString(),
                finalAsset: {
                    projectId: session.projectId,
                    fileId: fileRecord.id,
                    revision: fileRecord.revision ?? 1,
                },
                clearIntegrationError: true,
            });
            this.logger.info(`[Project file registered] uploadId=${session.uploadId} fileId=${fileRecord.id}`);
        } catch (error) {
            this.persistError(session, integrationError("register", error));
            return;
        }

        try {
            const dispatched = this.options.dispatchProjectFileProcessing(session.projectId, fileRecord, sourcePath);
            if (dispatched) {
                session = this.persist(session, {
                    integrationStage: "dispatched",
                    processingStartedAt: session.processingStartedAt ?? this.now().toISOString(),
                    clearIntegrationError: true,
                });
                this.logger.info(
                    `[Processing dispatched] uploadId=${session.uploadId}`
                    + ` fileId=${fileRecord.id} processor=${fileRecord.kind}`,
                );
            }
        } catch (error) {
            this.persistError(session, integrationError("dispatch", error));
        }
    }

    private requireCompleteSession(uploadId: string): UploadSessionRecord {
        const session = this.options.repository.get(uploadId);
        if (!session || session.status !== "complete"
            || session.finalBytes !== session.totalBytes
            || !session.finalSha256
            || !session.finalizedArtifactName
            || !session.reservedFileId) {
            throw new Error("Only a verified completed upload can be integrated.");
        }
        return session;
    }

    private async adoptCanonicalSource(session: UploadSessionRecord, destinationPath: string): Promise<UploadSessionRecord> {
        const stagedPath = this.options.repository.getFinalizedArtifactPath(session);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        let current = this.persist(session, { integrationStage: "adopting", clearIntegrationError: true });

        if (fs.existsSync(destinationPath)) {
            await this.assertSourceIntegrity(destinationPath, current);
            return current;
        }
        if (!fs.existsSync(stagedPath)) {
            throw new Error("Verified finalized artifact is missing before canonical project adoption.");
        }
        if (fs.statSync(stagedPath).size !== current.finalBytes) {
            throw new Error("Verified finalized artifact size does not match its manifest.");
        }
        // Both locations live under the same data root. Rename is atomic and
        // avoids a third multi-gigabyte source copy.
        fs.renameSync(stagedPath, destinationPath);
        return current;
    }

    private async assertSourceIntegrity(filePath: string, session: UploadSessionRecord): Promise<void> {
        if (fs.statSync(filePath).size !== session.finalBytes) {
            throw new Error("Canonical project source size does not match finalized upload metadata.");
        }
        // A pre-existing destination only occurs in a crash/retry window. In
        // that path a streamed re-hash is justified before adopting it.
        const hash = createHash("sha256");
        for await (const rawChunk of fs.createReadStream(filePath)) {
            hash.update(rawChunk);
        }
        if (hash.digest("hex") !== session.finalSha256) {
            throw new Error("Canonical project source hash does not match finalized upload metadata.");
        }
    }

    private persist(session: UploadSessionRecord, patch: IntegrationSessionPatch): UploadSessionRecord {
        const { integrationError: _previousIntegrationError, ...withoutPreviousIntegrationError } = session;
        const { clearIntegrationError: _clearIntegrationError, ...values } = patch;
        const next: UploadSessionRecord = {
            ...withoutPreviousIntegrationError,
            ...values,
            updatedAt: this.now().toISOString(),
        };
        this.options.repository.save(next);
        return next;
    }

    private persistError(session: UploadSessionRecord, error: UploadIntegrationError): void {
        this.persist(session, { integrationError: error });
    }
}
