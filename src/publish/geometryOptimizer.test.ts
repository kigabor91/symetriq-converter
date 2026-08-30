import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { GeometryOptimizerService } from "./geometryOptimizer.js";

test("generic geometry optimizer preserves source nodes and writes a separate optimized GLB", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "symetriq-publish-optimizer-"));
    const rawPath = path.join(directory, "raw.glb");
    const optimizedPath = path.join(directory, "optimized.glb");
    try {
        const document = new Document();
        const buffer = document.createBuffer();
        const positions = document.createAccessor("positions").setType("VEC3").setArray(new Float32Array([
            0, 0, 0, 1, 0, 0, 0, 1, 0,
            0, 0, 0, 0, 1, 0, 1, 0, 0,
        ])).setBuffer(buffer);
        const material = document.createMaterial("system-colour").setBaseColorFactor([0.1, 0.4, 0.8, 1]);
        const mesh = document.createMesh("mesh").addPrimitive(
            document.createPrimitive().setAttribute("POSITION", positions).setMaterial(material),
        );
        const scene = document.createScene();
        scene.addChild(document.createNode("revit-unique-id").setTranslation([12, 34, 56]).setMesh(mesh));
        writeFileSync(rawPath, await new NodeIO().writeBinary(document));
        const rawBytes = readFileSync(rawPath);

        const result = await new GeometryOptimizerService().optimize(rawPath, optimizedPath);

        assert.equal(readFileSync(rawPath).equals(rawBytes), true);
        assert.equal(result.inputPath, rawPath);
        assert.equal(result.outputPath, optimizedPath);
        assert.equal(result.inputTriangles, 2);
        assert.equal(result.outputTriangles, 2);
        const optimized = await new NodeIO().readBinary(readFileSync(optimizedPath));
        const node = optimized.getRoot().listNodes()[0]!;
        assert.equal(node.getName(), "revit-unique-id");
        assert.deepEqual(node.getTranslation(), [12, 34, 56]);
        assert.deepEqual(node.getMesh()!.listPrimitives()[0]!.getMaterial()!.getBaseColorFactor(), [0.1, 0.4, 0.8, 1]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
