export type PublishStatus = "received" | "optimizing" | "converting" | "completed" | "failed";
export type PublishJobStatus = "created" | PublishStatus;
export type PublishPipelineState = "created" | PublishStatus;

/**
 * A durable record of one Revit publish request. Processing-specific fields
 * intentionally do not live here yet: a later Publish Queue can extend this
 * model without changing the public API contract introduced in Sprint 001.
 */
export interface PublishJob {
    id: string;
    projectId: string;
    status: PublishJobStatus;
    receivedAt: string;
    pipeline: {
        state: PublishPipelineState;
        updatedAt: string;
    };
    workspace: {
        id: string;
    };
    model: {
        originalName: string;
        storedFileName: "model.glb";
        size: number;
    };
    metadata: {
        originalName: string;
        storedFileName: "metadata.json";
        size: number;
    };
    metrics?: {
        rawGlb: { bytes: number; vertices: number; triangles: number };
        optimizedGlb: { bytes: number; vertices: number; triangles: number };
        optimizationMilliseconds: number;
        conversionMilliseconds?: number;
        xktBytes?: number;
    };
    error?: string;
}

export interface PublishStatusResponse {
    publishId: string;
    status: PublishJobStatus;
}
