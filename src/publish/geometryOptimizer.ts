import * as fs from "node:fs/promises";
import { PublishWorkspace } from "./publishWorkspace.js";

export interface GeometryOptimizerResult {
    inputPath: string;
    outputPath: string;
    inputBytes: number;
    outputBytes: number;
}

/**
 * Geometry Optimizer pipeline boundary.
 *
 * Sprint 003 intentionally uses a byte-preserving write. The later geometry
 * optimization implementation belongs here, while the pipeline and the next
 * convert2xkt stage can rely on the stable optimized.glb contract today.
 */
export class GeometryOptimizer {
    async optimize(workspace: PublishWorkspace): Promise<GeometryOptimizerResult> {
        const glb = await fs.readFile(workspace.modelPath);
        await fs.writeFile(workspace.optimizedModelPath, glb);
        return {
            inputPath: workspace.modelPath,
            outputPath: workspace.optimizedModelPath,
            inputBytes: glb.byteLength,
            outputBytes: glb.byteLength,
        };
    }
}
