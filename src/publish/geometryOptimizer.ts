import { optimizeGlbForXkt, type GlbOptimizationStats } from "../glbOptimize.js";

export interface GeometryOptimizationResult extends GlbOptimizationStats {
    inputPath: string;
    outputPath: string;
    optimizationMilliseconds: number;
}

/**
 * Source-neutral GLB geometry optimization service.
 *
 * It only applies lossless operations: vertex welding, exact geometry/
 * accessor/material deduplication and index reordering. It neither flattens
 * nodes nor bakes transforms or emits meshopt-compressed GLB, preserving the
 * ordinary GLB contract consumed by convert2xkt.
 *
 * The current caller is the Revit Publish pipeline. Other sources can reuse
 * this service later without coupling it to the existing IFC conversion path.
 */
export class GeometryOptimizerService {
    async optimize(inputPath: string, outputPath: string): Promise<GeometryOptimizationResult> {
        const startedAt = performance.now();
        const stats = await optimizeGlbForXkt(inputPath, undefined, outputPath);
        return {
            inputPath,
            outputPath,
            optimizationMilliseconds: performance.now() - startedAt,
            ...stats,
        };
    }
}
