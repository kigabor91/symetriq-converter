import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PublishValidationError } from "./publishPipelineService.js";
import { validatePublishPackage } from "./publishPackageContract.js";

function upload(filePath: string, originalname: string): Express.Multer.File {
    return { path: filePath, originalname, size: fs.statSync(filePath).size } as Express.Multer.File;
}

function sha256(filePath: string): string {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("legacy two-file publish remains valid without a package contract", () => {
    const model = { path: "model", originalname: "model.glb", size: 1 } as Express.Multer.File;
    const metadata = { path: "metadata", originalname: "metadata.json", size: 1 } as Express.Multer.File;
    assert.equal(validatePublishPackage(model, metadata, {}, PublishValidationError), undefined);
});

test("Publish Package v1 validates manifest hashes and explicit one-to-many identity", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-package-v1-"));
    try {
        const modelPath = path.join(directory, "model.glb");
        const metadataPath = path.join(directory, "source-metadata.json");
        const objectMapPath = path.join(directory, "object-map.json");
        const manifestPath = path.join(directory, "manifest.json");
        fs.writeFileSync(modelPath, Buffer.from("unchanged-glb"));
        fs.writeFileSync(metadataPath, JSON.stringify({ version: 2, elements: {}, propertySets: {}, levels: [] }));
        fs.writeFileSync(objectMapPath, JSON.stringify({
            version: 1,
            packageId: "package-1",
            sourceKind: "revit",
            logicalElements: [{ logicalElementId: "logical-1", sourceElementId: "source-1", sourceType: "revit.element" }],
            renderObjects: [
                { renderObjectId: "render-1", logicalElementId: "logical-1", sourceElementId: "source-1", sourceType: "revit.element" },
                { renderObjectId: "render-2", logicalElementId: "logical-1", sourceElementId: "source-1", sourceType: "revit.element" },
            ],
        }));
        fs.writeFileSync(manifestPath, JSON.stringify({
            packageVersion: "1.0",
            packageId: "package-1",
            sourceKind: "revit",
            files: [
                { filename: "model.glb", size: fs.statSync(modelPath).size, sha256: sha256(modelPath) },
                { filename: "source-metadata.json", size: fs.statSync(metadataPath).size, sha256: sha256(metadataPath) },
                { filename: "object-map.json", size: fs.statSync(objectMapPath).size, sha256: sha256(objectMapPath) },
            ],
        }));

        const result = validatePublishPackage(
            upload(modelPath, "model.glb"),
            upload(metadataPath, "source-metadata.json"),
            { manifest: upload(manifestPath, "manifest.json"), objectMap: upload(objectMapPath, "object-map.json") },
            PublishValidationError,
        );

        assert.deepEqual(result, {
            packageVersion: "1.0",
            packageId: "package-1",
            sourceKind: "revit",
            renderObjectCount: 2,
            logicalElementCount: 1,
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("Publish Package v1 rejects an integrity mismatch", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-package-v1-invalid-"));
    try {
        const modelPath = path.join(directory, "model.glb");
        const metadataPath = path.join(directory, "source-metadata.json");
        const objectMapPath = path.join(directory, "object-map.json");
        const manifestPath = path.join(directory, "manifest.json");
        fs.writeFileSync(modelPath, "model");
        fs.writeFileSync(metadataPath, "{}");
        fs.writeFileSync(objectMapPath, JSON.stringify({ version: 1, packageId: "p", sourceKind: "revit", logicalElements: [], renderObjects: [] }));
        fs.writeFileSync(manifestPath, JSON.stringify({
            packageVersion: "1.0", packageId: "p", sourceKind: "revit",
            files: [
                { filename: "model.glb", size: 5, sha256: "wrong" },
                { filename: "source-metadata.json", size: 2, sha256: sha256(metadataPath) },
                { filename: "object-map.json", size: fs.statSync(objectMapPath).size, sha256: sha256(objectMapPath) },
            ],
        }));

        assert.throws(() => validatePublishPackage(
            upload(modelPath, "model.glb"), upload(metadataPath, "source-metadata.json"),
            { manifest: upload(manifestPath, "manifest.json"), objectMap: upload(objectMapPath, "object-map.json") },
            PublishValidationError,
        ), /SHA-256/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
