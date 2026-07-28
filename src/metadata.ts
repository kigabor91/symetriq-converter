import type * as WebIFCModule from "web-ifc";
import * as fs from "node:fs";

export interface SymetriqProperty {
    name: string;
    value: unknown;
    type?: string;
    description?: string;
}

export interface SymetriqPropertySet {
    id: string;
    name: string;
    type: string;
    properties: SymetriqProperty[];
}

export interface SymetriqElement {
    globalId: string;
    type: string;
    name: string;
    parentId?: string;
    propertySetIds: string[];
}

/** Source-neutral spatial level, expressed in the model's local vertical axis (metres). */
export interface SymetriqLevel {
    id: string;
    name: string;
    elevation: number;
    source: "ifc";
    method: "explicit";
}

export interface SymetriqMetadata {
    version: number;
    elements: Record<string, SymetriqElement>;
    propertySets: Record<string, SymetriqPropertySet>;
    levels: SymetriqLevel[];
}

export interface MetadataDeduplicationStats {
    inputPropertySets: number;
    outputPropertySets: number;
    deduplicatedPropertySets: number;
}

const ifcGuidCharacters = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

type WebIFC = typeof WebIFCModule;
type IFCLine = Record<string, any>;

function valueOf(value: unknown): unknown {
    if (value && typeof value === "object" && "value" in value) {
        return (value as { value: unknown }).value;
    }
    return value;
}

function typeOf(line: IFCLine): string {
    return line.__proto__?.constructor?.name ?? "IfcUnknown";
}

function globalIdOf(line: IFCLine): string | undefined {
    const globalId = valueOf(line.GlobalId);
    return typeof globalId === "string" ? globalId : undefined;
}

function lineIdOf(reference: unknown): number | undefined {
    const value = valueOf(reference);
    return typeof value === "number" ? value : undefined;
}

function referencesOf(value: unknown): number[] {
    return (Array.isArray(value) ? value : [value])
        .map(lineIdOf)
        .filter((id): id is number => id !== undefined);
}

function getLengthUnitScale(WebIFC: WebIFC, ifcApi: InstanceType<WebIFC["IfcAPI"]>, modelId: number): number {
    const lineIds = ifcApi.GetAllLines(modelId);
    for (let index = 0; index < lineIds.size(); index++) {
        const project = ifcApi.GetLine(modelId, lineIds.get(index)) as IFCLine;
        if (typeOf(project) !== "IfcProject") continue;
        const assignmentId = lineIdOf(project.UnitsInContext);
        if (assignmentId === undefined) break;
        const assignment = ifcApi.GetLine(modelId, assignmentId) as IFCLine;
        for (const unitId of referencesOf(assignment.Units)) {
            const unit = ifcApi.GetLine(modelId, unitId) as IFCLine;
            if (typeOf(unit) === "IfcSIUnit" && valueOf(unit.UnitType) === "LENGTHUNIT") {
                const prefix = valueOf(unit.Prefix);
                return prefix === "MILLI" ? 0.001 : prefix === "CENTI" ? 0.01 : 1;
            }
        }
    }
    return 1;
}

function globalIdToUuid(globalId: string): string {
    let value = 0n;

    for (const character of globalId) {
        const digit = ifcGuidCharacters.indexOf(character);
        if (digit < 0) {
            throw new Error(`Invalid IFC GlobalId: ${globalId}`);
        }
        value = value * 64n + BigInt(digit);
    }

    const hex = value.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getGlbNodeNames(glbPath: string): string[] {
    const glb = fs.readFileSync(glbPath);
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as {
        nodes?: Array<{ name?: string }>;
    };

    return (json.nodes ?? [])
        .map((node) => node.name)
        .filter((name): name is string => name !== undefined);
}

/**
 * IfcConvert names GLB nodes as `product-<UUID>-body`, while IFC itself uses
 * compressed 22-character GlobalIds. Re-key the element lookup table to the
 * node names that become XKT entity IDs in the next conversion stage.
 */
export function mapMetadataToGlbNodes(
    metadata: SymetriqMetadata,
    glbPath: string,
): SymetriqMetadata {
    const uuidToGlobalId = new Map<string, string>();

    for (const globalId of Object.keys(metadata.elements)) {
        uuidToGlobalId.set(globalIdToUuid(globalId), globalId);
    }

    const elements: Record<string, SymetriqElement> = {};
    for (const nodeName of getGlbNodeNames(glbPath)) {
        const match = /^product-([0-9a-f-]{36})-body$/i.exec(nodeName);
        const uuid = match?.[1];
        const globalId = uuid ? uuidToGlobalId.get(uuid.toLowerCase()) : undefined;
        const element = globalId ? metadata.elements[globalId] : undefined;

        if (element) {
            elements[nodeName] = element;
        }
    }

    return {
        ...metadata,
        elements,
    };
}

/**
 * Consolidates byte-for-byte equivalent PropertySet payloads.
 *
 * Revit IFC exports commonly create a separate IFC PropertySet instance for
 * every element, even where its name, type and every property are identical.
 * The Viewer only resolves a PropertySet through an element's
 * `propertySetIds`, so those references can safely point to the first
 * equivalent instance. Element IDs, names, categories and all displayed
 * property values remain unchanged.
 */
export function deduplicateMetadataPropertySets(
    metadata: SymetriqMetadata,
): { metadata: SymetriqMetadata; stats: MetadataDeduplicationStats } {
    const canonicalIdBySignature = new Map<string, string>();
    const canonicalIdByOriginalId = new Map<string, string>();
    const propertySets: Record<string, SymetriqPropertySet> = {};

    for (const [propertySetId, propertySet] of Object.entries(metadata.propertySets)) {
        const signature = JSON.stringify({
            name: propertySet.name,
            type: propertySet.type,
            properties: propertySet.properties,
        });
        const canonicalId = canonicalIdBySignature.get(signature) ?? propertySetId;
        canonicalIdBySignature.set(signature, canonicalId);
        canonicalIdByOriginalId.set(propertySetId, canonicalId);
        if (!propertySets[canonicalId]) {
            propertySets[canonicalId] = propertySet;
        }
    }

    const elements = Object.fromEntries(
        Object.entries(metadata.elements).map(([elementId, element]) => [
            elementId,
            {
                ...element,
                propertySetIds: element.propertySetIds.map(
                    (propertySetId) => canonicalIdByOriginalId.get(propertySetId) ?? propertySetId,
                ),
            },
        ]),
    );
    const inputPropertySets = Object.keys(metadata.propertySets).length;
    const outputPropertySets = Object.keys(propertySets).length;

    return {
        metadata: { ...metadata, elements, propertySets },
        stats: {
            inputPropertySets,
            outputPropertySets,
            deduplicatedPropertySets: inputPropertySets - outputPropertySets,
        },
    };
}

/**
 * Extracts semantic IFC metadata without loading or tessellating geometry.
 * Geometry is intentionally handled by IfcConvert in the production pipeline.
 */
export async function extractMetadata(
    WebIFC: WebIFC,
    sourceData: Uint8Array,
): Promise<SymetriqMetadata> {
    const ifcApi = new WebIFC.IfcAPI();
    await ifcApi.Init();

    const modelId = ifcApi.OpenModel(sourceData);

    try {
        const elements: Record<string, SymetriqElement> = {};
        const propertySets: Record<string, SymetriqPropertySet> = {};
        const elementParents = new Map<string, string>();
        const propertySetAssignments = new Map<string, string[]>();
        const lineIds = ifcApi.GetAllLines(modelId);
        const unitScale = getLengthUnitScale(WebIFC, ifcApi, modelId);
        const levels: SymetriqLevel[] = [];

        for (let index = 0; index < lineIds.size(); index++) {
            const line = ifcApi.GetLine(modelId, lineIds.get(index)) as IFCLine;
            const type = typeOf(line);
            const globalId = globalIdOf(line);

            if (type === "IfcBuildingStorey" && globalId) {
                const elevation = valueOf(line.Elevation);
                if (typeof elevation === "number") {
                    const name = valueOf(line.Name);
                    levels.push({
                        id: globalId,
                        name: typeof name === "string" && name ? name : globalId,
                        elevation: elevation * unitScale,
                        source: "ifc",
                        method: "explicit",
                    });
                }
            }

            if (
                globalId
                && !type.startsWith("IfcRel")
                && type !== "IfcPropertySet"
                && type !== "IfcElementQuantity"
            ) {
                const name = valueOf(line.Name);
                elements[globalId] = {
                    globalId,
                    type,
                    name: typeof name === "string" && name !== "" ? name : type,
                    propertySetIds: [],
                };
            }

            if (type === "IfcRelAggregates" || type === "IfcRelContainedInSpatialStructure") {
                const parentReference = type === "IfcRelAggregates"
                    ? line.RelatingObject
                    : line.RelatingStructure;
                const parentId = lineIdOf(parentReference);
                const parent = parentId === undefined
                    ? undefined
                    : ifcApi.GetLine(modelId, parentId) as IFCLine;
                const parentGlobalId = parent ? globalIdOf(parent) : undefined;

                if (parentGlobalId) {
                    for (const childId of referencesOf(line.RelatedObjects ?? line.RelatedElements)) {
                        const childGlobalId = globalIdOf(ifcApi.GetLine(modelId, childId) as IFCLine);
                        if (childGlobalId) {
                            elementParents.set(childGlobalId, parentGlobalId);
                        }
                    }
                }
            }

            if (type !== "IfcRelDefinesByProperties") {
                continue;
            }

            const definitionId = lineIdOf(line.RelatingPropertyDefinition);
            if (definitionId === undefined) {
                continue;
            }

            const definition = ifcApi.GetLine(modelId, definitionId) as IFCLine;
            const propertySetId = globalIdOf(definition);
            if (!propertySetId) {
                continue;
            }

            const properties: SymetriqProperty[] = [];
            for (const propertyId of referencesOf(definition.HasProperties)) {
                const property = ifcApi.GetLine(modelId, propertyId) as IFCLine;
                const name = valueOf(property.Name);
                const nominalValue = property.NominalValue as IFCLine | undefined;

                if (typeof name !== "string" || !nominalValue) {
                    continue;
                }

                const serializedProperty: SymetriqProperty = {
                    name,
                    value: valueOf(nominalValue),
                    type: nominalValue.type,
                };
                const description = valueOf(property.Description) ?? valueOf(nominalValue.description);
                if (typeof description === "string") {
                    serializedProperty.description = description;
                }
                properties.push(serializedProperty);
            }

            const propertySetName = valueOf(definition.Name);
            propertySets[propertySetId] = {
                id: propertySetId,
                name: typeof propertySetName === "string" ? propertySetName : propertySetId,
                type: typeOf(definition),
                properties,
            };

            for (const relatedObjectId of referencesOf(line.RelatedObjects)) {
                const relatedObject = ifcApi.GetLine(modelId, relatedObjectId) as IFCLine;
                const relatedGlobalId = globalIdOf(relatedObject);
                if (!relatedGlobalId) {
                    continue;
                }
                const assignments = propertySetAssignments.get(relatedGlobalId) ?? [];
                assignments.push(propertySetId);
                propertySetAssignments.set(relatedGlobalId, assignments);
            }
        }

        for (const [globalId, element] of Object.entries(elements)) {
            const parentId = elementParents.get(globalId);
            if (parentId) {
                element.parentId = parentId;
            }
            element.propertySetIds = propertySetAssignments.get(globalId) ?? [];
        }

        return { version: 2, elements, propertySets, levels: levels.sort((a, b) => a.elevation - b.elevation) };
    } finally {
        ifcApi.CloseModel(modelId);
        ifcApi.Dispose();
    }
}
