import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PublishPipelineService } from "./publishPipelineService.js";
import { PublishModelConverter } from "./publishModelConverter.js";
import { PublishProjectUpdater } from "./publishProjectUpdater.js";
import { PublishStorage } from "./publishStore.js";
import { PublishWorkspace } from "./publishWorkspace.js";
import type { PublishModelConversionResult } from "./publishModelConverter.js";

test("publish pipeline publishes converted XKT into the project update layer", async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-publish-"));
    try {
        const uploadDirectory = path.join(testDirectory, "uploads");
        fs.mkdirSync(uploadDirectory);
        const modelPath = path.join(uploadDirectory, "revit-model.glb");
        const metadataPath = path.join(uploadDirectory, "metadata.json");
        fs.writeFileSync(modelPath, Buffer.from("glTF"));
        fs.writeFileSync(metadataPath, "{}");
        const storage = new PublishStorage(path.join(testDirectory, "storage"));
        const publishedModels: Array<{ projectId: string; publishId: string; converted: PublishModelConversionResult }> = [];
        const modelConverter = {
            async convert(workspace: PublishWorkspace): Promise<PublishModelConversionResult> {
                fs.writeFileSync(workspace.xktPath, Buffer.from("xkt"));
                return { xktPath: workspace.xktPath, metadataPath: workspace.metadataPath };
            },
        } as PublishModelConverter;
        const projectUpdater = {
            async addModel(projectId: string, publishId: string, _originalName: string, converted: PublishModelConversionResult): Promise<void> {
                publishedModels.push({ projectId, publishId, converted });
            },
        } as PublishProjectUpdater;
        const pipeline = new PublishPipelineService(
            storage,
            (publishId) => new PublishWorkspace(publishId, path.join(testDirectory, "workspaces")),
            undefined,
            modelConverter,
            projectUpdater,
        );

        const result = await pipeline.start("project-1", {
            path: modelPath, originalname: "revit-model.glb", size: 4,
        } as Express.Multer.File, {
            path: metadataPath, originalname: "metadata.json", size: 2,
        } as Express.Multer.File);

        const job = storage.getJob(result.publishId);
        assert.deepEqual(result, { publishId: result.publishId, status: "received" });
        assert.equal(job?.status, "completed");
        assert.equal(job?.pipeline.state, "completed");
        assert.equal(job?.workspace.id, result.publishId);
        assert.equal(fs.existsSync(path.join(testDirectory, "workspaces", result.publishId, "model.glb")), true);
        assert.equal(fs.existsSync(path.join(testDirectory, "workspaces", result.publishId, "metadata.json")), true);
        assert.equal(fs.readFileSync(path.join(testDirectory, "workspaces", result.publishId, "optimized.glb")).equals(Buffer.from("glTF")), true);
        assert.equal(fs.readFileSync(path.join(testDirectory, "workspaces", result.publishId, "model.xkt")).equals(Buffer.from("xkt")), true);
        assert.equal(publishedModels[0]?.projectId, "project-1");
        assert.equal(publishedModels[0]?.publishId, result.publishId);
    } finally {
        fs.rmSync(testDirectory, { recursive: true, force: true });
    }
});

test("publish pipeline records a failed conversion for status polling", async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-publish-failure-"));
    try {
        const uploadDirectory = path.join(testDirectory, "uploads");
        fs.mkdirSync(uploadDirectory);
        const modelPath = path.join(uploadDirectory, "revit-model.glb");
        const metadataPath = path.join(uploadDirectory, "metadata.json");
        fs.writeFileSync(modelPath, Buffer.from("glTF"));
        fs.writeFileSync(metadataPath, "{}");
        const storage = new PublishStorage(path.join(testDirectory, "storage"));
        const pipeline = new PublishPipelineService(
            storage,
            (publishId) => new PublishWorkspace(publishId, path.join(testDirectory, "workspaces")),
            undefined,
            { async convert(): Promise<PublishModelConversionResult> { throw new Error("convert2xkt test failure"); } } as PublishModelConverter,
        );

        const result = await pipeline.start("project-1", {
            path: modelPath, originalname: "revit-model.glb", size: 4,
        } as Express.Multer.File, {
            path: metadataPath, originalname: "metadata.json", size: 2,
        } as Express.Multer.File);

        assert.equal(result.status, "received");
        assert.equal(storage.getJob(result.publishId)?.status, "failed");
        assert.match(storage.getJob(result.publishId)?.error ?? "", /convert2xkt test failure/);
    } finally {
        fs.rmSync(testDirectory, { recursive: true, force: true });
    }
});
