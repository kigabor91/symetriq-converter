export interface RevitSourceParameterDefinition {
    parameterId: string;
    name: string;
    scopes?: string[];
    source?: string;
    builtInParameter?: string | null;
    sharedParameterGuid?: string | null;
    parameterGroup?: string | null;
    storageType?: string;
    specTypeId?: string | null;
    unitTypeId?: string | null;
    isReadOnly?: boolean;
    isVisible?: boolean;
}

export interface RevitSourceParameterValue {
    parameterId: string;
    rawValue: unknown;
    displayValue?: string | null;
}

export interface RevitSourceType {
    typeId: string;
    sourceTypeId: string;
    familyName?: string | null;
    name?: string | null;
    parameterValues: RevitSourceParameterValue[];
}

export interface RevitSourceElement {
    logicalElementId: string;
    sourceElementId: string;
    typeId?: string | null;
    category?: string;
    family?: string | null;
    type?: string | null;
    instanceParameterValues: RevitSourceParameterValue[];
    levelId?: string | null;
    levelAssignment?: "explicit" | "unknown";
}

export interface RevitSourceLevel {
    id: string;
    name: string;
    elevation: number;
    sortOrder: number;
    source: "revit" | string;
    method: "explicit" | string;
}

export interface RevitSourceMetadataV1 {
    version: "1.0";
    sourceKind: "revit";
    parameterDefinitions: RevitSourceParameterDefinition[];
    types: RevitSourceType[];
    elements: RevitSourceElement[];
    levels?: RevitSourceLevel[];
}

export interface PublishObjectMapRenderObject {
    renderObjectId: string;
    logicalElementId: string;
    sourceElementId: string;
    sourceType: string;
    geometry?: { kind?: string; nodeIndex?: number; legacyNodeName?: string | null };
}

export interface PublishObjectMapV1 {
    version: 1;
    packageId: string;
    sourceKind: "revit";
    logicalElements: Array<{ logicalElementId: string; sourceElementId: string; sourceType: string }>;
    renderObjects: PublishObjectMapRenderObject[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Type guard for the producer-owned, complete Revit source record. */
export function isRevitSourceMetadataV1(value: unknown): value is RevitSourceMetadataV1 {
    return isRecord(value)
        && value.version === "1.0"
        && value.sourceKind === "revit"
        && Array.isArray(value.parameterDefinitions)
        && Array.isArray(value.types)
        && Array.isArray(value.elements);
}

export function isPublishObjectMapV1(value: unknown): value is PublishObjectMapV1 {
    return isRecord(value)
        && value.version === 1
        && value.sourceKind === "revit"
        && Array.isArray(value.logicalElements)
        && Array.isArray(value.renderObjects);
}
