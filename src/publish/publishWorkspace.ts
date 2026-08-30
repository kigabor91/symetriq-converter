import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDirectory } from "../projectStore.js";

const defaultWorkspacesDirectory = path.join(getDataDirectory(), "publish-workspaces");

export interface PublishWorkspaceFiles {
    modelPath: string;
    metadataPath: string;
    optimizedModelPath: string;
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

    createFromUpload(model: Express.Multer.File, metadata: Express.Multer.File): PublishWorkspaceFiles {
        fs.mkdirSync(this.workspacesDirectory, { recursive: true });
        fs.mkdirSync(this.directory, { recursive: false });
        const modelPath = this.modelPath;
        const metadataPath = this.metadataPath;
        try {
            fs.renameSync(model.path, modelPath);
            fs.renameSync(metadata.path, metadataPath);
            return { modelPath, metadataPath, optimizedModelPath: this.optimizedModelPath };
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
