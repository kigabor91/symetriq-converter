import * as fs from "node:fs";
import type {
    SymetriqElement,
    SymetriqMetadata,
    SymetriqProperty,
    SymetriqPropertySet,
} from "../metadata.js";

type JsonRecord = Record<string, unknown>;

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
 * Converts producer-specific Revit Copilot metadata into the source-neutral
 * metadata contract consumed by the Viewer. Copilot exports GLB nodes named
 * with Revit UniqueId, and convert2xkt preserves those node names as XKT
 * entity IDs. The same UniqueId is therefore deliberately used as the
 * canonical `elements` key.
 */
export class PublishMetadataNormalizer {
    normalize(metadata: unknown): SymetriqMetadata {
        if (isCanonicalMetadata(metadata)) {
            return metadata;
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

    normalizeFile(metadataPath: string): SymetriqMetadata {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
        const normalized = this.normalize(metadata);
        fs.writeFileSync(metadataPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        return normalized;
    }
}
