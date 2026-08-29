import { convert2xkt } from "@xeokit/xeokit-convert";
import * as fs from "node:fs";
import { PublishWorkspace } from "./publishWorkspace.js";

export interface PublishModelConversionResult {
    xktPath: string;
    metadataPath: string;
}

/** Converts the optimizer output to the exact XKT/metadata contract used by the Viewer. */
export class PublishModelConverter {
    async convert(workspace: PublishWorkspace): Promise<PublishModelConversionResult> {
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
        return { xktPath: workspace.xktPath, metadataPath: workspace.metadataPath };
    }
}
