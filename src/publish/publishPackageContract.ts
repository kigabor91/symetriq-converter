import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { PublishValidationError } from "./publishPipelineService.js";

type JsonRecord = Record<string, unknown>;

export interface PublishPackageUploads {
    manifest?: Express.Multer.File | undefined;
    objectMap?: Express.Multer.File | undefined;
}

export interface ValidatedPublishPackage {
    packageVersion: "1.0";
    packageId: string;
    sourceKind: string;
    renderObjectCount: number;
    logicalElementCount: number;
}

function record(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function json(file: Express.Multer.File, label: string, validationError: new (message: string) => PublishValidationError): JsonRecord {
    try {
        const value = record(JSON.parse(fs.readFileSync(file.path, "utf8")) as unknown);
        if (!value) throw new Error("root is not an object");
        return value;
    } catch {
        throw new validationError(`${label} must contain a valid JSON object.`);
    }
}

function string(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hash(path: string): string {
    const digest = createHash("sha256");
    const descriptor = fs.openSync(path, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let count = 0;
        do {
            count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (count > 0) digest.update(buffer.subarray(0, count));
        } while (count > 0);
    } finally {
        fs.closeSync(descriptor);
    }
    return digest.digest("hex");
}

function verifyFile(
    manifestFiles: unknown,
    filename: string,
    upload: Express.Multer.File,
    validationError: new (message: string) => PublishValidationError,
): void {
    const entries = Array.isArray(manifestFiles) ? manifestFiles.map(record).filter((item): item is JsonRecord => Boolean(item)) : [];
    const entry = entries.find((item) => item.filename === filename);
    if (!entry) throw new validationError(`manifest.json does not describe ${filename}.`);
    if (entry.size !== upload.size) throw new validationError(`${filename} size does not match manifest.json.`);
    if (string(entry.sha256)?.toLowerCase() !== hash(upload.path)) throw new validationError(`${filename} SHA-256 does not match manifest.json.`);
}

/** Validates Publish Package v1 as a boundary contract. It deliberately does
 * not alter GLB, optimizer, convert2xkt, or canonical metadata behavior. */
export function validatePublishPackage(
    model: Express.Multer.File,
    metadata: Express.Multer.File,
    uploads: PublishPackageUploads,
    validationError: new (message: string) => PublishValidationError,
): ValidatedPublishPackage | undefined {
    if (!uploads.manifest && !uploads.objectMap) return undefined;
    if (!uploads.manifest || !uploads.objectMap) throw new validationError("Publish Package v1 requires both manifest and objectMap files.");

    const manifest = json(uploads.manifest, "manifest.json", validationError);
    const objectMap = json(uploads.objectMap, "object-map.json", validationError);
    if (manifest.packageVersion !== "1.0") throw new validationError("Unsupported Publish Package version.");
    const packageId = string(manifest.packageId);
    const sourceKind = string(manifest.sourceKind);
    if (!packageId || !sourceKind) throw new validationError("manifest.json requires packageId and sourceKind.");
    if (objectMap.version !== 1 || objectMap.packageId !== packageId || objectMap.sourceKind !== sourceKind) {
        throw new validationError("object-map.json does not belong to manifest.json.");
    }

    const logicalElements = Array.isArray(objectMap.logicalElements) ? objectMap.logicalElements.map(record).filter((item): item is JsonRecord => Boolean(item)) : [];
    const renderObjects = Array.isArray(objectMap.renderObjects) ? objectMap.renderObjects.map(record).filter((item): item is JsonRecord => Boolean(item)) : [];
    const logicalIds = new Set(logicalElements.map((item) => string(item.logicalElementId)).filter((id): id is string => Boolean(id)));
    const renderIds = renderObjects.map((item) => string(item.renderObjectId)).filter((id): id is string => Boolean(id));
    if (logicalIds.size !== logicalElements.length || new Set(renderIds).size !== renderObjects.length) {
        throw new validationError("object-map.json identities must be present and unique.");
    }
    for (const renderObject of renderObjects) {
        if (!logicalIds.has(string(renderObject.logicalElementId) ?? "")) throw new validationError("object-map.json contains an unknown logicalElementId reference.");
        if (!string(renderObject.sourceElementId) || !string(renderObject.sourceType)) throw new validationError("object-map.json render objects require source identity.");
    }
    for (const logicalId of logicalIds) {
        if (!renderObjects.some((item) => item.logicalElementId === logicalId)) throw new validationError("Every logical element must have at least one render object.");
    }

    verifyFile(manifest.files, "model.glb", model, validationError);
    verifyFile(manifest.files, "source-metadata.json", metadata, validationError);
    verifyFile(manifest.files, "object-map.json", uploads.objectMap, validationError);
    return { packageVersion: "1.0", packageId, sourceKind, renderObjectCount: renderObjects.length, logicalElementCount: logicalElements.length };
}
