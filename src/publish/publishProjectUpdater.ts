import * as fs from "node:fs";
import * as path from "node:path";
import { createCompressedAssetVariants } from "../assetCompression.js";
import { getProjectDirectory, updateProject } from "../projectStore.js";
import type { PublishModelConversionResult } from "./publishModelConverter.js";

/** Makes a completed Publish package visible through the existing project-file API. */
export class PublishProjectUpdater {
    async addModel(
        projectId: string,
        publishId: string,
        originalName: string,
        convertedModel: PublishModelConversionResult,
    ): Promise<void> {
        const outputDirectory = path.join(getProjectDirectory(projectId), "converted", publishId);
        fs.mkdirSync(outputDirectory, { recursive: true });
        const xktPath = path.join(outputDirectory, `${publishId}.xkt`);
        const metadataPath = path.join(outputDirectory, `${publishId}.metadata.json`);
        fs.copyFileSync(convertedModel.xktPath, xktPath);
        fs.copyFileSync(convertedModel.metadataPath, metadataPath);
        await Promise.all([createCompressedAssetVariants(xktPath), createCompressedAssetVariants(metadataPath)]);

        const updatedProject = updateProject(projectId, (project) => {
            project.files.push({
                id: publishId,
                revision: 1,
                originalName,
                // Published GLB models expose the same XKT contract as IFC
                // packages. Keeping this kind preserves current Viewer support.
                kind: "ifc",
                status: "ready",
                model: {
                    id: publishId,
                    geometry: { format: "xkt", src: `/project-files/${projectId}/converted/${publishId}/${publishId}.xkt?v=1` },
                    metadata: { format: "json", src: `/project-files/${projectId}/converted/${publishId}/${publishId}.metadata.json?v=1` },
                },
            });
        });
        if (!updatedProject) throw new Error("Project not found while publishing the converted model.");
    }
}
