import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDirectory } from "../projectStore.js";

const defaultWorkspacesDirectory = path.join(getDataDirectory(), "publish-workspaces");

export interface PublishWorkspaceFiles {
    modelPath: string;
    sourceMetadataPath: string;
    metadataPath: string;
    optimizedModelPath: string;
    manifestPath?: string;
    objectMapPath?: string;
}

/**
 * Owns the per-publish staging directory. Future pipeline stages receive this
 * workspace instead of reaching into HTTP/Multer temporary files.
 */
export class PublishWorkspace {
    constructor(readonly id: string, private readonly workspacesDirectory = defaultWorkspacesDirectory) {}

    get directory(): string {
        return path.join(this.workspacesDirectory, this.id);
    }

    get modelPath(): string {
        return path.join(this.directory, "model.glb");
    }

    get optimizedModelPath(): string {
        return path.join(this.directory, "optimized.glb");
    }

    get xktPath(): string {
        return path.join(this.directory, "model.xkt");
    }

    get metadataPath(): string {
        return path.join(this.directory, "metadata.json");
    }

    /** Immutable producer input. The Viewer-facing canonical metadata is written separately. */
    get sourceMetadataPath(): string {
        return path.join(this.directory, "source-metadata.json");
    }

    get manifestPath(): string {
        return path.join(this.directory, "manifest.json");
    }

    get objectMapPath(): string {
        return path.join(this.directory, "object-map.json");
    }

    /** Hub-owned normalized metadata database; never served to the Viewer at bootstrap. */
    get propertyStorePath(): string {
        return path.join(this.directory, "canonical-property-store.sqlite");
    }

    createFromUpload(model: Express.Multer.File, metadata: Express.Multer.File, manifest?: Express.Multer.File, objectMap?: Express.Multer.File): PublishWorkspaceFiles {
        fs.mkdirSync(this.workspacesDirectory, { recursive: true });
        fs.mkdirSync(this.directory, { recursive: false });
        const modelPath = this.modelPath;
        const sourceMetadataPath = this.sourceMetadataPath;
        try {
            fs.renameSync(model.path, modelPath);
            fs.renameSync(metadata.path, sourceMetadataPath);
            if (manifest) fs.renameSync(manifest.path, this.manifestPath);
            if (objectMap) fs.renameSync(objectMap.path, this.objectMapPath);
            return {
                modelPath,
                sourceMetadataPath,
                metadataPath: this.metadataPath,
                optimizedModelPath: this.optimizedModelPath,
                ...(manifest ? { manifestPath: this.manifestPath } : {}),
                ...(objectMap ? { objectMapPath: this.objectMapPath } : {}),
            };
        } catch (error) {
            fs.rmSync(this.directory, { recursive: true, force: true });
            throw error;
        }
    }

    remove(): void {
        fs.rmSync(this.directory, { recursive: true, force: true });
    }

    /** The source upload is not part of the completed publish package. */
    removeRawModel(): void {
        fs.rmSync(this.modelPath, { force: true });
    }
}
