import { convert2xkt } from "@xeokit/xeokit-convert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as WebIFC from "web-ifc";
import { convertIfcToGlb } from "./ifcConvert.js";
import { optimizeGlbForXkt, type GlbOptimizationStats } from "./glbOptimize.js";
import { createCompressedAssetVariants } from "./assetCompression.js";
import { extractCoordinateReference, type CoordinateReference } from "./coordinateReference.js";
import {
    deduplicateMetadataPropertySets,
    extractMetadata,
    mapMetadataToGlbNodes,
} from "./metadata.js";

export interface ConversionResult {
    id: string;
    glbPath: string;
    xktPath: string;
    metadataPath: string;
    manifestPath: string;
    optimization: GlbOptimizationStats;
    coordinateReference?: CoordinateReference;
}

function getMeshSimplificationProfile(): { ratio: number; error: number } {
    const ratio = Number(process.env.SYMETRIQ_MESH_SIMPLIFICATION_RATIO ?? "0.40");
    const error = Number(process.env.SYMETRIQ_MESH_SIMPLIFICATION_ERROR ?? "0.002");
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
        throw new Error("SYMETRIQ_MESH_SIMPLIFICATION_RATIO must be greater than 0 and at most 1.");
    }
    if (!Number.isFinite(error) || error < 0) {
        throw new Error("SYMETRIQ_MESH_SIMPLIFICATION_ERROR must be zero or greater.");
    }
    return { ratio, error };
}

export async function convertIfc(
    inputPath: string,
    outputDirectory: string,
    modelId = path.parse(inputPath).name,
    signal?: AbortSignal,
): Promise<ConversionResult> {
    if (signal?.aborted) throw new Error("Conversion cancelled.");
    const glbPath = path.join(outputDirectory, `${modelId}.glb`);
    const xktPath = path.join(outputDirectory, `${modelId}.xkt`);
    const metadataPath = path.join(outputDirectory, `${modelId}.metadata.json`);
    const manifestPath = path.join(outputDirectory, `${modelId}.manifest.json`);
    const inputFile = fs.readFileSync(inputPath);
    const simplification = getMeshSimplificationProfile();
    fs.mkdirSync(outputDirectory, { recursive: true });

    console.log(`IFC size: ${Math.round(inputFile.length / 1024 / 1024)} MB`);
    // Revit's Project Base Point IFC exports commonly contain large survey
    // coordinates. Apply their inverse while IfcConvert creates the GLB so
    // the XKT never contains large absolute coordinates. LAS/LAZ receives
    // the exact same inverse origin in server.ts.
    const coordinateReference = await extractCoordinateReference(WebIFC, inputFile);
    const modelOffset = coordinateReference
        ? coordinateReference.origin.map((coordinate) => -coordinate) as [number, number, number]
        : undefined;
    console.log("Step 1/5: Converting IFC to GLB with IfcConvert...");
    await convertIfcToGlb(inputPath, glbPath, modelOffset, signal);

    if (signal?.aborted) throw new Error("Conversion cancelled.");

    console.log(`Step 2/5: Optimizing GLB (Meshopt ${Math.round(simplification.ratio * 100)}%, node IDs retained)...`);
    const optimization = await optimizeGlbForXkt(glbPath, { simplification });
    if (signal?.aborted) throw new Error("Conversion cancelled.");
    const savedBytes = optimization.inputBytes - optimization.outputBytes;
    console.log(`GLB: ${(optimization.inputBytes / 1024 / 1024).toFixed(2)} MB -> ${(optimization.outputBytes / 1024 / 1024).toFixed(2)} MB (${savedBytes >= 0 ? "saved" : "added"} ${(Math.abs(savedBytes) / 1024 / 1024).toFixed(2)} MB)`);

    console.log("Step 3/5: Extracting IFC metadata...");
    const mappedMetadata = mapMetadataToGlbNodes(
        await extractMetadata(WebIFC, inputFile),
        glbPath,
    );
    const { metadata, stats: metadataDeduplication } = deduplicateMetadataPropertySets(mappedMetadata);
    if (signal?.aborted) throw new Error("Conversion cancelled.");
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    console.log(
        `Metadata PropertySets: ${metadataDeduplication.inputPropertySets} -> ${metadataDeduplication.outputPropertySets} `
        + `(${metadataDeduplication.deduplicatedPropertySets} duplicates removed).`,
    );

    console.log("Step 4/5: Converting GLB to XKT...");
    await convert2xkt({
        source: glbPath,
        outputXKT: (xktArrayBuffer: ArrayBuffer) => {
            fs.writeFileSync(xktPath, Buffer.from(xktArrayBuffer));
        },
        configs: {
            sourceConfigs: {
                glb: {
                    // Plan view relies on practical model edges for its outline.
                    // Very dense meshes remain excluded to protect conversion time.
                    maxIndicesForEdge: 10000,
                },
            },
        },
        log: (msg: string) => console.log(msg),
    });
    if (signal?.aborted) throw new Error("Conversion cancelled.");

    console.log("Step 5/5: Creating Brotli and gzip Viewer assets...");
    const [xktCompression, metadataCompression] = await Promise.all([
        createCompressedAssetVariants(xktPath),
        createCompressedAssetVariants(metadataPath),
    ]);
    console.log(
        `Transfer assets (Brotli): XKT ${(xktCompression.sourceBytes / 1024 / 1024).toFixed(2)} MB -> ${(xktCompression.brotliBytes / 1024 / 1024).toFixed(2)} MB, `
        + `metadata ${(metadataCompression.sourceBytes / 1024 / 1024).toFixed(2)} MB -> ${(metadataCompression.brotliBytes / 1024 / 1024).toFixed(2)} MB.`,
    );

    fs.writeFileSync(
        manifestPath,
        JSON.stringify({
            version: 1,
            id: modelId,
            geometry: { format: "xkt", src: `${modelId}.xkt` },
            metadata: { format: "json", src: `${modelId}.metadata.json` },
            optimization,
            meshSimplification: simplification,
            ...(coordinateReference ? { coordinateReference } : {}),
        }, null, 2),
    );

    console.log("Done.");
    return {
        id: modelId,
        glbPath,
        xktPath,
        metadataPath,
        manifestPath,
        optimization,
        ...(coordinateReference ? { coordinateReference } : {}),
    };
}

export async function convert(): Promise<void> {
    await convertIfc(
        "./input/minta_ifc.ifc",
        "./output",
        "minta_ifc",
    );
}
