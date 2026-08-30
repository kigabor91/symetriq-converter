import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PublishJob, PublishStatusResponse } from "./publishModels.js";
import { GeometryOptimizerService } from "./geometryOptimizer.js";
import { PublishModelConverter } from "./publishModelConverter.js";
import { PublishMetadataNormalizer } from "./publishMetadataNormalizer.js";
import { PublishProjectUpdater } from "./publishProjectUpdater.js";
import { PublishStorage } from "./publishStore.js";
import { PublishWorkspace } from "./publishWorkspace.js";

export class PublishValidationError extends Error {}

function removeFileIfPresent(file: Express.Multer.File | undefined): void {
    if (file) fs.rmSync(file.path, { force: true });
}

function validateUpload(
    model: Express.Multer.File | undefined,
    metadata: Express.Multer.File | undefined,
): { model: Express.Multer.File; metadata: Express.Multer.File } {
    if (!model || !metadata) throw new PublishValidationError("Both model (GLB) and metadata (JSON) files are required.");
    if (path.extname(model.originalname).toLowerCase() !== ".glb") throw new PublishValidationError("The model file must have a .glb extension.");
    if (path.extname(metadata.originalname).toLowerCase() !== ".json") throw new PublishValidationError("The metadata file must have a .json extension.");
    try {
        JSON.parse(fs.readFileSync(metadata.path, "utf8"));
    } catch {
        throw new PublishValidationError("The metadata file must contain valid JSON.");
    }
    return { model, metadata };
}

/**
 * Synchronous pipeline foundation. This establishes durable jobs and isolated
 * workspaces only; a future queue/worker can continue from the recorded state.
 */
export class PublishPipelineService {
    constructor(
        private readonly storage = new PublishStorage(),
        private readonly workspaceFactory: (publishId: string) => PublishWorkspace = (publishId) => new PublishWorkspace(publishId),
        private readonly geometryOptimizer = new GeometryOptimizerService(),
        private readonly modelConverter = new PublishModelConverter(),
        private readonly metadataNormalizer = new PublishMetadataNormalizer(),
        private readonly projectUpdater = new PublishProjectUpdater(),
    ) {}

    async start(projectId: string, uploadedModel: Express.Multer.File | undefined, uploadedMetadata: Express.Multer.File | undefined): Promise<PublishStatusResponse> {
        let workspace: PublishWorkspace | undefined;
        let publishId: string | undefined;
        let jobStored = false;
        try {
            const { model, metadata } = validateUpload(uploadedModel, uploadedMetadata);
            publishId = randomUUID();
            const now = new Date().toISOString();
            workspace = this.workspaceFactory(publishId);
            workspace.createFromUpload(model, metadata);

            const job: PublishJob = {
                id: publishId,
                projectId,
                status: "created",
                receivedAt: now,
                pipeline: { state: "created", updatedAt: now },
                workspace: { id: workspace.id },
                model: { originalName: model.originalname, storedFileName: "model.glb", size: model.size },
                metadata: { originalName: metadata.originalname, storedFileName: "metadata.json", size: metadata.size },
            };
            this.storage.createJob(job);
            jobStored = true;

            const receivedAt = new Date().toISOString();
            this.storage.updateJob(publishId, (storedJob) => {
                storedJob.status = "received";
                storedJob.pipeline = { state: "received", updatedAt: receivedAt };
            });
            this.storage.updateJob(publishId, (storedJob) => {
                storedJob.status = "optimizing";
                storedJob.pipeline = { state: "optimizing", updatedAt: new Date().toISOString() };
            });
            const optimization = await this.geometryOptimizer.optimize(workspace.modelPath, workspace.optimizedModelPath);
            console.info(
                `[Publish optimizer] raw ${(optimization.inputBytes / 1024 / 1024).toFixed(2)} MB, `
                + `${optimization.inputVertices} vertices, ${optimization.inputTriangles} triangles -> `
                + `optimized ${(optimization.outputBytes / 1024 / 1024).toFixed(2)} MB, `
                + `${optimization.outputVertices} vertices, ${optimization.outputTriangles} triangles `
                + `in ${optimization.optimizationMilliseconds.toFixed(0)} ms`,
            );
            this.storage.updateJob(publishId, (storedJob) => {
                storedJob.status = "converting";
                storedJob.pipeline = { state: "converting", updatedAt: new Date().toISOString() };
            });
            const convertedModel = await this.modelConverter.convert(workspace);
            this.metadataNormalizer.normalizeFile(workspace.metadataPath);
            await this.projectUpdater.addModel(projectId, publishId, model.originalname, convertedModel);
            workspace.removeRawModel();
            this.storage.updateJob(publishId, (storedJob) => {
                storedJob.status = "completed";
                storedJob.pipeline = { state: "completed", updatedAt: new Date().toISOString() };
                storedJob.metrics = {
                    rawGlb: {
                        bytes: optimization.inputBytes,
                        vertices: optimization.inputVertices,
                        triangles: optimization.inputTriangles,
                    },
                    optimizedGlb: {
                        bytes: optimization.outputBytes,
                        vertices: optimization.outputVertices,
                        triangles: optimization.outputTriangles,
                    },
                    optimizationMilliseconds: optimization.optimizationMilliseconds,
                    ...(convertedModel.conversionMilliseconds === undefined
                        ? {}
                        : { conversionMilliseconds: convertedModel.conversionMilliseconds }),
                    ...(convertedModel.xktBytes === undefined ? {} : { xktBytes: convertedModel.xktBytes }),
                };
            });
            // Preserve the Publish API acknowledgement contract. The status
            // endpoint exposes the completed processing state immediately.
            return { publishId, status: "received" };
        } catch (error) {
            removeFileIfPresent(uploadedModel);
            removeFileIfPresent(uploadedMetadata);
            if (jobStored && publishId) {
                const message = error instanceof Error ? error.message : String(error);
                this.storage.updateJob(publishId, (storedJob) => {
                    storedJob.status = "failed";
                    storedJob.pipeline = { state: "failed", updatedAt: new Date().toISOString() };
                    storedJob.error = message;
                });
                console.error(`Publish processing failed for ${publishId}:`, error);
                // The caller still receives the original acknowledgement and
                // can poll the durable job for its terminal failed state.
                return { publishId, status: "received" };
            } else {
                workspace?.remove();
            }
            throw error;
        }
    }

    getStatus(publishId: string): PublishStatusResponse | undefined {
        const job = this.storage.getJob(publishId);
        return job ? { publishId: job.id, status: job.status } : undefined;
    }
}
