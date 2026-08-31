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

interface RevitSourceParameterDefinition {
    parameterId: string;
    name: string;
    storageType?: string;
    specTypeId?: string | null;
    unitTypeId?: string | null;
}

interface RevitSourceParameterValue {
    parameterId: string;
    rawValue: unknown;
    displayValue?: string | null;
}

interface RevitSourceType {
    typeId: string;
    sourceTypeId: string;
    familyName?: string | null;
    name?: string | null;
    parameterValues: RevitSourceParameterValue[];
}

interface RevitSourceElement {
    logicalElementId: string;
    sourceElementId: string;
    typeId?: string | null;
    category?: string;
    family?: string | null;
    type?: string | null;
    instanceParameterValues: RevitSourceParameterValue[];
}

interface RevitSourceMetadataV1 {
    version: "1.0";
    sourceKind: "revit";
    parameterDefinitions: RevitSourceParameterDefinition[];
    types: RevitSourceType[];
    elements: RevitSourceElement[];
}

function isRevitSourceMetadataV1(value: unknown): value is RevitSourceMetadataV1 {
    return isRecord(value)
        && value.version === "1.0"
        && value.sourceKind === "revit"
        && Array.isArray(value.parameterDefinitions)
        && Array.isArray(value.types)
        && Array.isArray(value.elements);
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

function propertyType(definition: RevitSourceParameterDefinition | undefined): string | undefined {
    switch (definition?.storageType) {
        case "Integer": return "integer";
        case "Double": return "number";
        case "ElementId": return "elementId";
        case "String": return "string";
        default: return undefined;
    }
}

function sourceProperties(
    values: RevitSourceParameterValue[],
    definitions: Map<string, RevitSourceParameterDefinition>,
): SymetriqProperty[] {
    const names = new Set<string>();
    return values.map((value) => {
        const definition = definitions.get(value.parameterId);
        const baseName = definition?.name || value.parameterId;
        const name = names.has(baseName) ? `${baseName} [${value.parameterId}]` : baseName;
        names.add(baseName);
        const property: SymetriqProperty = {
            name,
            value: value.displayValue ?? value.rawValue,
        };
        const type = propertyType(definition);
        if (type) property.type = type;
        if (definition) {
            property.description = [
                definition.parameterId,
                definition.specTypeId ?? undefined,
                definition.unitTypeId ?? undefined,
            ].filter((part): part is string => Boolean(part)).join("; ");
        }
        return property;
    });
}

/**
 * Projects normalized Revit source metadata into the established canonical
 * Viewer contract. The full producer document stays in source-metadata.json;
 * this method intentionally creates only the Viewer representation.
 */
function normalizeRevitSourceMetadata(metadata: RevitSourceMetadataV1): SymetriqMetadata {
    const definitions = new Map(metadata.parameterDefinitions.map((definition) => [definition.parameterId, definition]));
    const types = new Map(metadata.types.map((type) => [type.typeId, type]));
    const elements: Record<string, SymetriqElement> = {};
    const propertySets: Record<string, SymetriqPropertySet> = {};

    for (const sourceElement of metadata.elements) {
        const sourceElementId = text(sourceElement.sourceElementId);
        if (!sourceElementId) continue;
        const type = sourceElement.typeId ? types.get(sourceElement.typeId) : undefined;
        const category = text(sourceElement.category, "Uncategorized");
        const family = text(sourceElement.family, type?.familyName ? text(type.familyName) : "");
        const typeName = text(sourceElement.type, type?.name ? text(type.name) : "");
        const identityPropertySetId = `revit:${sourceElementId}:identity`;
        const instancePropertySetId = `revit:${sourceElementId}:instance`;
        const typePropertySetId = type ? `revit:type:${type.typeId}` : undefined;
        const propertySetIds = [identityPropertySetId];

        if (sourceElement.instanceParameterValues.length > 0) propertySetIds.push(instancePropertySetId);
        if (type && type.parameterValues.length > 0 && typePropertySetId) propertySetIds.push(typePropertySetId);

        elements[sourceElementId] = {
            globalId: sourceElementId,
            type: category,
            name: family && typeName ? `${family} - ${typeName}` : family || typeName || category,
            propertySetIds,
        };
        propertySets[identityPropertySetId] = {
            id: identityPropertySetId,
            name: "Revit Identity",
            type: "Revit",
            properties: [
                { name: "Logical Element ID", value: sourceElement.logicalElementId, type: "string" },
                { name: "Revit Unique ID", value: sourceElementId, type: "string" },
                { name: "Category", value: category, type: "string" },
                { name: "Family", value: family, type: "string" },
                { name: "Type", value: typeName, type: "string" },
            ],
        };
        if (sourceElement.instanceParameterValues.length > 0) {
            propertySets[instancePropertySetId] = {
                id: instancePropertySetId,
                name: "Revit Instance Parameters",
                type: "Revit",
                properties: sourceProperties(sourceElement.instanceParameterValues, definitions),
            };
        }
        if (type && type.parameterValues.length > 0 && typePropertySetId && !propertySets[typePropertySetId]) {
            propertySets[typePropertySetId] = {
                id: typePropertySetId,
                name: "Revit Type Parameters",
                type: "Revit",
                properties: sourceProperties(type.parameterValues, definitions),
            };
        }
    }

    return { version: 2, elements, propertySets, levels: [] };
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

        if (isRevitSourceMetadataV1(metadata)) {
            return normalizeRevitSourceMetadata(metadata);
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

    normalizeFile(sourceMetadataPath: string, canonicalMetadataPath = sourceMetadataPath): SymetriqMetadata {
        const metadata = JSON.parse(fs.readFileSync(sourceMetadataPath, "utf8")) as unknown;
        const normalized = this.normalize(metadata);
        fs.writeFileSync(canonicalMetadataPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        return normalized;
    }
}
