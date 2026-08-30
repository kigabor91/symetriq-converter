import { NodeIO, PropertyType } from "@gltf-transform/core";
import { dedup, reorder, simplify, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import * as fs from "node:fs";

export interface GlbOptimizationStats {
    inputBytes: number;
    outputBytes: number;
    inputMeshes: number;
    outputMeshes: number;
    inputMaterials: number;
    outputMaterials: number;
    inputVertices: number;
    outputVertices: number;
    inputTriangles: number;
    outputTriangles: number;
}

export interface GlbSimplificationOptions {
    /** Fraction of triangles to retain (0–1). */
    ratio: number;
    /** Maximum geometric error as a fraction of each mesh radius. */
    error: number;
}

function getNodeNames(glb: Uint8Array): string[] {
    // GLB header (12 bytes), followed by the mandatory JSON chunk header (8).
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
        nodes?: Array<{ name?: string }>;
    };
    return (json.nodes ?? []).map((node) => node.name ?? "");
}

function countVertices(document: Awaited<ReturnType<NodeIO["readBinary"]>>): number {
    return document.getRoot().listMeshes().reduce((total, mesh) => total + mesh.listPrimitives()
        .reduce((meshTotal, primitive) => {
            const position = primitive.getAttribute("POSITION");
            return meshTotal + (position?.getCount() ?? 0);
        }, 0), 0);
}

function countTriangles(document: Awaited<ReturnType<NodeIO["readBinary"]>>): number {
    return document.getRoot().listMeshes().reduce((total, mesh) => total + mesh.listPrimitives()
        .reduce((meshTotal, primitive) => {
            if (primitive.getMode() !== 4) return meshTotal; // TRIANGLES
            const indices = primitive.getIndices();
            const position = primitive.getAttribute("POSITION");
            return meshTotal + Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3);
        }, 0), 0);
}

/**
 * Applies transformations while preserving all IFC product nodes.
 *
 * Nodes are IFC elements in this pipeline: their names become XKT entity IDs.
 * Therefore this deliberately does not join meshes, flatten the scene, or
 * instance nodes. Optional simplification only changes triangles within an
 * existing mesh; nodes, node names and metadata lookup IDs remain intact.
 */
export async function optimizeGlbForXkt(
    sourcePath: string,
    options?: { simplification?: GlbSimplificationOptions },
    outputPath = sourcePath,
): Promise<GlbOptimizationStats> {
    const input = fs.readFileSync(sourcePath);
    const inputNodeNames = getNodeNames(input);
    const io = new NodeIO();
    const document = await io.readBinary(input);
    const inputStats = {
        inputBytes: input.byteLength,
        inputMeshes: document.getRoot().listMeshes().length,
        inputMaterials: document.getRoot().listMaterials().length,
        inputVertices: countVertices(document),
        inputTriangles: countTriangles(document),
    };

    await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
    await document.transform(
        // Convert duplicate per-face vertices to indexed primitives. This is
        // bitwise exact: vertices differing in normals, UVs, or color remain separate.
        weld(),
        // Share identical geometry, accessors and visually identical materials
        // between separate IFC element nodes. Nodes remain untouched.
        dedup({
            propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.MATERIAL],
        }),
        ...(options?.simplification ? [
            // This is intentionally opt-in. Simplification preserves every IFC
            // node and material boundary, while reducing triangles inside each
            // individual mesh for an A/B-tested low-detail package.
            simplify({
                simplifier: MeshoptSimplifier,
                ratio: options.simplification.ratio,
                error: options.simplification.error,
                lockBorder: true,
            }),
        ] : []),
        // Losslessly reorder indexed triangles/vertices for the GPU vertex cache.
        // The GLB is subsequently read by convert2xkt, so EXT_meshopt_compression
        // itself is intentionally not written: its decoder is not a dependency of
        // the XKT converter.
        reorder({ encoder: MeshoptEncoder, target: "performance" }),
    );

    const output = await io.writeBinary(document);
    const outputNodeNames = getNodeNames(output);
    if (inputNodeNames.length !== outputNodeNames.length
        || inputNodeNames.some((name, index) => name !== outputNodeNames[index])) {
        throw new Error("GLB optimization changed IFC node identities; output was not written.");
    }

    fs.writeFileSync(outputPath, output);
    return {
        ...inputStats,
        outputBytes: output.byteLength,
        outputMeshes: document.getRoot().listMeshes().length,
        outputMaterials: document.getRoot().listMaterials().length,
        outputVertices: countVertices(document),
        outputTriangles: countTriangles(document),
    };
}
