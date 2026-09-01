import * as fs from "node:fs";
import type {
    SymetriqLevel,
    SymetriqElement,
    SymetriqMetadata,
    SymetriqProperty,
    SymetriqPropertySet,
} from "../metadata.js";
import {
    isRevitSourceMetadataV1,
    type PublishObjectMapV1,
    type RevitSourceMetadataV1,
} from "./revitSourceMetadata.js";
import { CanonicalPropertyStore, type CanonicalPropertyStoreStats } from "./canonicalPropertyStore.js";

type JsonRecord = Record<string, unknown>;

export interface MetadataNormalizationResult {
    metadata: SymetriqMetadata;
    sourceBytes: number;
    canonicalBytes: number;
    propertyStore?: CanonicalPropertyStoreStats;
}

function isRecord(value: unknown): value is JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
    return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function categoryName(value: unknown): string {
    if (isRecord(value)) return text(value.name, text(value.id, "Uncategorized"));
    return text(value, "Uncategorized");
}

function isCanonicalMetadata(value: unknown): value is SymetriqMetadata {
    if (!isRecord(value)) return false;
    return typeof value.version === "number"
        && isRecord(value.elements)
        && isRecord(value.propertySets)
        && Array.isArray(value.levels);
}

function revitProperties(element: JsonRecord, uniqueId: string): SymetriqProperty[] {
    return [
        { name: "Revit Element ID", value: element.elementId ?? "", type: "string" },
        { name: "Revit Unique ID", value: uniqueId, type: "string" },
        { name: "Category", value: categoryName(element.category), type: "string" },
        { name: "Family", value: text(element.family), type: "string" },
        { name: "Type", value: text(element.type), type: "string" },
    ];
}

/**
 * Projects normalized Revit source metadata into the established canonical
 * Viewer contract. The full producer document stays in source-metadata.json.
 *
 * Deliberately do not expand the full source parameter graph here. On large
 * projects that turns a deduplicated producer file into hundreds of megabytes
 * of duplicated Viewer property sets and can exceed V8's single-string limit.
 * Canonical semantic property-set mapping is a separate, Hub-owned milestone.
 */
function normalizeRevitSourceMetadata(
    metadata: RevitSourceMetadataV1,
    objectMap?: PublishObjectMapV1,
): SymetriqMetadata {
    const types = new Map(metadata.types.map((type) => [type.typeId, type]));
    const sourcesByLogicalId = new Map(metadata.elements.map((element) => [element.logicalElementId, element]));
    const elements: Record<string, SymetriqElement> = {};
    const propertySets: Record<string, SymetriqPropertySet> = {};
    const levels: SymetriqLevel[] = (metadata.levels ?? [])
        .filter((level) => Number.isFinite(level.elevation))
        .map((level) => ({ id: level.id, name: level.name || level.id, elevation: level.elevation, source: level.source || "revit", method: level.method || "explicit" }))
        .sort((left, right) => left.elevation - right.elevation || left.id.localeCompare(right.id));
    const knownLevelIds = new Set(levels.map((level) => level.id));

    const projectionEntries = objectMap?.renderObjects.map((renderObject) => ({
        sourceElement: sourcesByLogicalId.get(renderObject.logicalElementId),
        // XKT currently preserves GLB node names, not the Package v1 render ID.
        viewerObjectId: text(renderObject.geometry?.legacyNodeName, text(renderObject.sourceElementId)),
        renderObjectId: renderObject.renderObjectId,
    })) ?? metadata.elements.map((sourceElement) => ({
        sourceElement,
        viewerObjectId: text(sourceElement.sourceElementId),
        renderObjectId: `legacy:${sourceElement.sourceElementId}`,
    }));

    for (const entry of projectionEntries) {
        const sourceElement = entry.sourceElement;
        if (!sourceElement) continue;
        const sourceElementId = text(entry.viewerObjectId);
        if (!sourceElementId) continue;
        const type = sourceElement.typeId ? types.get(sourceElement.typeId) : undefined;
        const category = text(sourceElement.category, "Uncategorized");
        const family = text(sourceElement.family, type?.familyName ? text(type.familyName) : "");
        const typeName = text(sourceElement.type, type?.name ? text(type.name) : "");
        elements[sourceElementId] = {
            globalId: sourceElementId,
            type: category,
            name: family && typeName ? `${family} - ${typeName}` : family || typeName || category,
            propertySetIds: [],
            ...(sourceElement.levelId && knownLevelIds.has(sourceElement.levelId) ? { parentId: sourceElement.levelId } : {}),
            identity: {
                logicalElementId: sourceElement.logicalElementId,
                revitUniqueId: sourceElement.sourceElementId,
                category,
                family,
                type: typeName,
            },
            propertyStore: { renderObjectId: entry.renderObjectId },
            spatial: sourceElement.levelId && knownLevelIds.has(sourceElement.levelId)
                ? { levelId: sourceElement.levelId, levelAssignment: "explicit" }
                : { levelAssignment: "unknown" },
        };
    }

    return { version: 2, elements, propertySets, levels };
}

/**
 * Converts producer-specific Revit Copilot metadata into the source-neutral
 * metadata contract consumed by the Viewer. Copilot exports GLB nodes named
 * with Revit UniqueId, and convert2xkt preserves those node names as XKT
 * entity IDs. The same UniqueId is therefore deliberately used as the
 * canonical `elements` key.
 */
export class PublishMetadataNormalizer {
    constructor(private readonly propertyStore = new CanonicalPropertyStore()) {}

    normalize(metadata: unknown, objectMap?: PublishObjectMapV1): SymetriqMetadata {
        if (isCanonicalMetadata(metadata)) {
            return metadata;
        }

        if (isRevitSourceMetadataV1(metadata)) {
            return normalizeRevitSourceMetadata(metadata, objectMap);
        }

        const incomingElements = isRecord(metadata) && Array.isArray(metadata.elements)
            ? metadata.elements
            : [];
        const elements: Record<string, SymetriqElement> = {};
        const propertySets: Record<string, SymetriqPropertySet> = {};

        for (const incomingElement of incomingElements) {
            if (!isRecord(incomingElement)) continue;
            const uniqueId = text(incomingElement.uniqueId);
            if (!uniqueId) continue;

            const propertySetId = `revit:${uniqueId}`;
            const family = text(incomingElement.family);
            const type = text(incomingElement.type);
            const category = categoryName(incomingElement.category);

            elements[uniqueId] = {
                globalId: uniqueId,
                type: category,
                name: family && type ? `${family} - ${type}` : family || type || category,
                propertySetIds: [propertySetId],
            };
            propertySets[propertySetId] = {
                id: propertySetId,
                name: "Revit Element",
                type: "Revit",
                properties: revitProperties(incomingElement, uniqueId),
            };
        }

        // Revit exports currently do not contain trustworthy level elevation
        // data. Keeping this empty is intentional; level support can be added
        // later without fabricating spatial information.
        return { version: 2, elements, propertySets, levels: [] };
    }

    normalizeFile(
        sourceMetadataPath: string,
        canonicalMetadataPath = sourceMetadataPath,
        propertyStoreDirectory?: string,
    ): MetadataNormalizationResult {
        const sourceBytes = fs.statSync(sourceMetadataPath).size;
        const metadata = JSON.parse(fs.readFileSync(sourceMetadataPath, "utf8")) as unknown;
        return this.project(metadata, sourceBytes, canonicalMetadataPath, propertyStoreDirectory);
    }

    /** Projects an already parsed source record, avoiding a second large JSON parse. */
    project(
        metadata: unknown,
        sourceBytes: number,
        canonicalMetadataPath: string,
        propertyStoreDirectory?: string,
        objectMap?: PublishObjectMapV1,
    ): MetadataNormalizationResult {
        const normalized = this.normalize(metadata, objectMap);
        const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
        fs.writeFileSync(canonicalMetadataPath, serialized, "utf8");
        const canonicalBytes = Buffer.byteLength(serialized);
        const propertyStore = propertyStoreDirectory && isRevitSourceMetadataV1(metadata)
            ? this.propertyStore.build(metadata, propertyStoreDirectory, sourceBytes, canonicalBytes, objectMap)
            : undefined;
        console.info(
            `[Publish metadata] source ${(sourceBytes / 1024 / 1024).toFixed(2)} MB -> `
            + `bootstrap ${(canonicalBytes / 1024 / 1024).toFixed(2)} MB`
            + (propertyStore ? `; property store ${(propertyStore.databaseBytes / 1024 / 1024).toFixed(2)} MB` : ""),
        );
        return { metadata: normalized, sourceBytes, canonicalBytes, ...(propertyStore ? { propertyStore } : {}) };
    }
}
