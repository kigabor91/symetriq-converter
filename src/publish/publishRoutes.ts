import * as fs from "node:fs";
import * as path from "node:path";
import express from "express";
import multer from "multer";
import { getDataDirectory, readProjects, type ProjectRecord } from "../projectStore.js";
import { PublishPipelineService, PublishValidationError } from "./publishPipelineService.js";

const publishUploadDirectory = path.join(getDataDirectory(), "publish-upload-temp");
fs.mkdirSync(publishUploadDirectory, { recursive: true });

const publishUpload = multer({
    dest: publishUploadDirectory,
    limits: { files: 2, fileSize: 20 * 1024 * 1024 * 1024 },
});

/** Stable Copilot-facing representation of a project that accepts publishes. */
export interface PublishableProjectResponse {
    id: string;
    name: string;
}

export function toPublishableProjects(
    projects: ReadonlyArray<Pick<ProjectRecord, "id" | "name">>,
): PublishableProjectResponse[] {
    return projects.map(({ id, name }) => ({ id, name }));
}

function uploadedFile(request: express.Request, fieldName: "model" | "metadata"): Express.Multer.File | undefined {
    const files = request.files;
    if (!files || Array.isArray(files)) return undefined;
    return files[fieldName]?.[0];
}

function removeTemporaryFiles(request: express.Request): void {
    ([uploadedFile(request, "model"), uploadedFile(request, "metadata")]).forEach((file) => {
        if (file) fs.rmSync(file.path, { force: true });
    });
}

export function createPublishRouter(pipeline = new PublishPipelineService()): express.Router {
    const router = express.Router();

    router.get("/projects", (_request, response) => {
        response.json(toPublishableProjects(readProjects()));
    });

    router.post(
        "/projects/:projectId/publish",
        publishUpload.fields([{ name: "model", maxCount: 1 }, { name: "metadata", maxCount: 1 }]),
        async (request, response, next) => {
            const projectId = String(request.params.projectId ?? "");
            if (!readProjects().some((project) => project.id === projectId)) {
                removeTemporaryFiles(request);
                response.status(404).json({ error: "Project not found." });
                return;
            }
            try {
                response.status(201).json(await pipeline.start(projectId, uploadedFile(request, "model"), uploadedFile(request, "metadata")));
            } catch (error) {
                if (error instanceof PublishValidationError) {
                    response.status(400).json({ error: error.message });
                    return;
                }
                next(error);
            }
        },
    );

    router.get("/publishes/:publishId", (request, response) => {
        const publish = pipeline.getStatus(String(request.params.publishId ?? ""));
        if (!publish) {
            response.status(404).json({ error: "Publish not found." });
            return;
        }
        response.json(publish);
    });

    return router;
}
