import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PublishPipelineService } from "./publishPipelineService.js";
import { GeometryOptimizerService } from "./geometryOptimizer.js";
import { PublishModelConverter } from "./publishModelConverter.js";
import { PublishMetadataNormalizer } from "./publishMetadataNormalizer.js";
import { PublishProjectUpdater } from "./publishProjectUpdater.js";
import { PublishStorage } from "./publishStore.js";
import { PublishWorkspace } from "./publishWorkspace.js";
import type { PublishModelConversionResult } from "./publishModelConverter.js";

function createTestOptimizer(): GeometryOptimizerService {
    return {
        async optimize(inputPath: string, outputPath: string) {
            fs.copyFileSync(inputPath, outputPath);
            return {
                inputPath,
                outputPath,
                inputBytes: 4,
                outputBytes: 4,
                inputMeshes: 1,
                outputMeshes: 1,
                inputMaterials: 1,
                outputMaterials: 1,
                inputVertices: 3,
                outputVertices: 3,
                inputTriangles: 1,
                outputTriangles: 1,
                optimizationMilliseconds: 1,
            };
        },
    } as GeometryOptimizerService;
}

test("publish pipeline publishes converted XKT into the project update layer", async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-publish-"));
    try {
        const uploadDirectory = path.join(testDirectory, "uploads");
        fs.mkdirSync(uploadDirectory);
        const modelPath = path.join(uploadDirectory, "revit-model.glb");
        const metadataPath = path.join(uploadDirectory, "metadata.json");
        fs.writeFileSync(modelPath, Buffer.from("glTF"));
        fs.writeFileSync(metadataPath, JSON.stringify({
            schemaVersion: "1.0",
            elements: [{
                uniqueId: "revit-unique-id",
                elementId: 42,
                category: { id: "OST_PipeCurves", name: "Pipes" },
                family: "Pipe Types",
                type: "Standard",
            }],
        }));
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
            createTestOptimizer(),
            modelConverter,
            undefined,
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
        assert.deepEqual(job?.metrics, {
            rawGlb: { bytes: 4, vertices: 3, triangles: 1 },
            optimizedGlb: { bytes: 4, vertices: 3, triangles: 1 },
            optimizationMilliseconds: 1,
        });
        assert.equal(job?.workspace.id, result.publishId);
        assert.equal(fs.existsSync(path.join(testDirectory, "workspaces", result.publishId, "model.glb")), false);
        assert.equal(fs.existsSync(path.join(testDirectory, "workspaces", result.publishId, "metadata.json")), true);
        assert.equal(fs.existsSync(path.join(testDirectory, "workspaces", result.publishId, "source-metadata.json")), true);
        assert.equal(fs.readFileSync(path.join(testDirectory, "workspaces", result.publishId, "optimized.glb")).equals(Buffer.from("glTF")), true);
        assert.equal(fs.readFileSync(path.join(testDirectory, "workspaces", result.publishId, "model.xkt")).equals(Buffer.from("xkt")), true);
        const normalizedMetadata = JSON.parse(fs.readFileSync(path.join(testDirectory, "workspaces", result.publishId, "metadata.json"), "utf8"));
        assert.equal(normalizedMetadata.version, 2);
        assert.equal(normalizedMetadata.levels.length, 0);
        assert.deepEqual(normalizedMetadata.elements["revit-unique-id"].propertySetIds, ["revit:revit-unique-id"]);
        assert.deepEqual(normalizedMetadata.propertySets["revit:revit-unique-id"].properties.map((property: { name: string; value: unknown }) => [property.name, property.value]), [
            ["Revit Element ID", 42],
            ["Revit Unique ID", "revit-unique-id"],
            ["Category", "Pipes"],
            ["Family", "Pipe Types"],
            ["Type", "Standard"],
        ]);
        assert.equal(publishedModels[0]?.projectId, "project-1");
        assert.equal(publishedModels[0]?.publishId, result.publishId);
    } finally {
        fs.rmSync(testDirectory, { recursive: true, force: true });
    }
});

test("normalized Revit source metadata retains full parameters while the Viewer receives canonical metadata", () => {
    const sourceMetadata = {
        version: "1.0",
        sourceKind: "revit",
        parameterDefinitions: [
            { parameterId: "builtin:42", name: "Diameter", storageType: "Double", specTypeId: "autodesk.spec.aec:length-2.0.0", unitTypeId: "autodesk.unit.unit:millimeters-1.0.0" },
            { parameterId: "shared:guid-1", name: "Asset Code", storageType: "String" },
        ],
        types: [{
            typeId: "revit-type:type-1", sourceTypeId: "type-1", familyName: "Pipe Types", name: "DN100",
            parameterValues: [{ parameterId: "builtin:42", rawValue: 0.328084, displayValue: "100 mm" }],
        }],
        elements: [{
            logicalElementId: "le-1", sourceElementId: "revit-unique-1", typeId: "revit-type:type-1",
            category: "Pipes", family: "Pipe Types", type: "DN100",
            instanceParameterValues: [{ parameterId: "shared:guid-1", rawValue: "P-01", displayValue: "P-01" }],
        }, {
            logicalElementId: "le-2", sourceElementId: "revit-unique-2", typeId: "revit-type:type-1",
            category: "Pipes", family: "Pipe Types", type: "DN100",
            instanceParameterValues: [],
        }],
    };

    const normalized = new PublishMetadataNormalizer().normalize(sourceMetadata);

    assert.equal(normalized.version, 2);
    assert.deepEqual(normalized.elements["revit-unique-1"]!.propertySetIds, [
        "revit:revit-unique-1:identity",
        "revit:revit-unique-1:instance",
        "revit:type:revit-type:type-1",
    ]);
    assert.deepEqual(normalized.elements["revit-unique-2"]!.propertySetIds, [
        "revit:revit-unique-2:identity",
        "revit:type:revit-type:type-1",
    ]);
    assert.equal(normalized.propertySets["revit:type:revit-type:type-1"]!.properties[0]?.value, "100 mm");
    assert.equal(normalized.propertySets["revit:revit-unique-1:instance"]!.properties[0]?.value, "P-01");
    assert.equal(Object.keys(normalized.propertySets).filter((id) => id.startsWith("revit:type:")).length, 1);
});

test("metadata normalizer preserves existing canonical IFC metadata", () => {
    const metadata = {
        version: 2,
        elements: {
            "ifc-node": { globalId: "ifc-guid", type: "IfcWall", name: "Wall", propertySetIds: ["pset-1"] },
        },
        propertySets: {
            "pset-1": { id: "pset-1", name: "Pset_WallCommon", type: "IfcPropertySet", properties: [] },
        },
        levels: [],
    };

    assert.equal(new PublishMetadataNormalizer().normalize(metadata), metadata);
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
            createTestOptimizer(),
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
