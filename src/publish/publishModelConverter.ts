import { convert2xkt } from "@xeokit/xeokit-convert";
import * as fs from "node:fs";
import { PublishWorkspace } from "./publishWorkspace.js";

export interface PublishModelConversionResult {
    xktPath: string;
    metadataPath: string;
    xktBytes?: number;
    conversionMilliseconds?: number;
}

/** Converts the optimizer output to the exact XKT/metadata contract used by the Viewer. */
export class PublishModelConverter {
    async convert(workspace: PublishWorkspace): Promise<PublishModelConversionResult> {
        const startedAt = performance.now();
        await convert2xkt({
            source: workspace.optimizedModelPath,
            outputXKT: (xktArrayBuffer: ArrayBuffer) => {
                fs.writeFileSync(workspace.xktPath, Buffer.from(xktArrayBuffer));
            },
            configs: {
                sourceConfigs: {
                    glb: { maxIndicesForEdge: 10000 },
                },
            },
            log: (message: string) => console.log(`[Publish convert2xkt] ${message}`),
        });
        const xktBytes = fs.statSync(workspace.xktPath).size;
        return {
            xktPath: workspace.xktPath,
            metadataPath: workspace.metadataPath,
            xktBytes,
            conversionMilliseconds: performance.now() - startedAt,
        };
    }
}
