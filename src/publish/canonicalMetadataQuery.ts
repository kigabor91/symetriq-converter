import * as fs from "node:fs";

export interface CanonicalPropertyValueQueryResult {
    values: Array<{ valueId: string; displayValue: string; count: number }>;
    rendererObjectIds: string[];
}

type CanonicalMetadata = {
    elements?: Record<string, {
        propertySetIds?: string[];
        identity?: { category?: string; family?: string; type?: string };
    }>;
    propertySets?: Record<string, {
        name?: string;
        properties?: Array<{ name?: string; value?: unknown }>;
    }>;
};

/** Queries IFC-style canonical JSON with the same IDs and response shape as the Revit Store. */
export function queryCanonicalMetadataProperty(
    metadataPath: string,
    definitionId: string,
    valueIds?: string[],
): CanonicalPropertyValueQueryResult {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as CanonicalMetadata;
    const facet = /^canonical:facet:(category|family|type)$/.exec(definitionId)?.[1] as "category" | "family" | "type" | undefined;
    const values = new Map<string, { valueId: string; displayValue: string; count: number }>();
    const rendererObjectIds: string[] = [];
    const record = (rendererObjectId: string, displayValue: string) => {
        const valueId = `value:${encodeURIComponent(displayValue)}`;
        const entry = values.get(valueId) ?? { valueId, displayValue, count: 0 };
        entry.count += 1;
        values.set(valueId, entry);
        if (valueIds?.includes(valueId)) rendererObjectIds.push(rendererObjectId);
    };
    if (facet) {
        Object.entries(metadata.elements ?? {}).forEach(([rendererObjectId, element]) => {
            const value = element.identity?.[facet];
            if (value) record(rendererObjectId, value);
        });
    } else {
        const prefix = "canonical:instance:";
        if (!definitionId.startsWith(prefix)) return { values: [], rendererObjectIds: [] };
        const key = definitionId.slice(prefix.length);
        const separator = key.lastIndexOf(":");
        if (separator < 1) return { values: [], rendererObjectIds: [] };
        const propertySetName = key.slice(0, separator);
        const propertyName = key.slice(separator + 1);
        Object.entries(metadata.elements ?? {}).forEach(([rendererObjectId, element]) => {
            const property = (element.propertySetIds ?? [])
                .flatMap((id) => metadata.propertySets?.[id] ? [metadata.propertySets[id]] : [])
                .find((set) => set.name === propertySetName)?.properties?.find((item) => item.name === propertyName);
            if (property) record(rendererObjectId, String(property.value ?? ""));
        });
    }
    return { values: [...values.values()].sort((a, b) => a.displayValue.localeCompare(b.displayValue, undefined, { numeric: true })), rendererObjectIds };
}
