import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { optimizeGlbForXkt } from "./glbOptimize.js";

function createDuplicateMesh(document: Document, name: string) {
    const buffer = document.getRoot().listBuffers()[0]!;
    const material = document.createMaterial(`${name}-material`).setBaseColorFactor([0.8, 0.8, 0.8, 1]);
    const positions = document.createAccessor(`${name}-positions`).setType("VEC3").setArray(new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        0, 0, 0, 0, 1, 0, 1, 0, 0,
    ])).setBuffer(buffer);
    const indices = document.createAccessor(`${name}-indices`).setType("SCALAR").setArray(new Uint16Array([0, 1, 2, 3, 4, 5])).setBuffer(buffer);
    return document.createMesh(`${name}-mesh`).addPrimitive(
        document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices).setMaterial(material),
    );
}

test("GLB optimization preserves IFC node identities while sharing exact geometry", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "symetriq-glb-opt-"));
    const glbPath = path.join(directory, "model.glb");
    try {
        const document = new Document();
        document.createBuffer();
        const scene = document.createScene();
        scene.addChild(document.createNode("product-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-body").setMesh(createDuplicateMesh(document, "one")));
        scene.addChild(document.createNode("product-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-body").setMesh(createDuplicateMesh(document, "two")));
        writeFileSync(glbPath, await new NodeIO().writeBinary(document));

        const stats = await optimizeGlbForXkt(glbPath);
        assert.ok(stats.outputVertices < stats.inputVertices);
        assert.equal(stats.outputMeshes, 1);

        const optimized = await new NodeIO().readBinary(readFileSync(glbPath));
        assert.deepEqual(
            optimized.getRoot().listNodes().map((node) => node.getName()),
            [
                "product-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-body",
                "product-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-body",
            ],
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
