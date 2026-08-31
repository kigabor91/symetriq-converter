import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
    PublishObjectMapV1,
    RevitSourceMetadataV1,
    RevitSourceParameterDefinition,
    RevitSourceParameterValue,
} from "./revitSourceMetadata.js";

export interface CanonicalPropertyStoreStats {
    storeVersion: 1;
    sourceKind: "revit";
    sourceBytes: number;
    viewerBootstrapBytes: number;
    databaseBytes: number;
    processingMilliseconds: number;
    heapUsedDeltaBytes: number;
    rssDeltaBytes: number;
    definitions: number;
    propertyValues: number;
    propertySets: number;
    types: number;
    elements: number;
    renderObjects: number;
    levels: number;
}

export interface StoredCanonicalProperty {
    parameterId: string;
    name: string;
    scope: "instance" | "type";
    rawValue: unknown;
    displayValue: string | null;
    storageType: string | null;
    specTypeId: string | null;
    unitTypeId: string | null;
}

export interface StoredElementProperties {
    logicalElementId: string;
    sourceElementId: string;
    typeId: string | null;
    category: string;
    family: string | null;
    type: string | null;
    properties: StoredCanonicalProperty[];
}

type Definition = RevitSourceParameterDefinition;

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function json(value: unknown): string {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
}

function digest(...parts: string[]): string {
    const hash = createHash("sha256");
    for (const part of parts) {
        hash.update(part);
        hash.update("\u0000");
    }
    return hash.digest("hex");
}

function count(database: DatabaseSync, table: string): number {
    return Number((database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value);
}

/**
 * Hub-owned normalized property database. The source document is preserved
 * unchanged; this store removes repeated definitions, values and property-set
 * payloads and leaves the Viewer with only a compact metadata projection.
 */
export class CanonicalPropertyStore {
    static readonly databaseFilename = "canonical-property-store.sqlite";
    static readonly manifestFilename = "canonical-property-store.manifest.json";

    build(
        source: RevitSourceMetadataV1,
        directory: string,
        sourceBytes: number,
        viewerBootstrapBytes = 0,
        objectMap?: PublishObjectMapV1,
    ): CanonicalPropertyStoreStats {
        fs.mkdirSync(directory, { recursive: true });
        const databasePath = path.join(directory, CanonicalPropertyStore.databaseFilename);
        fs.rmSync(databasePath, { force: true });
        const before = process.memoryUsage();
        const startedAt = performance.now();
        const database = new DatabaseSync(databasePath);
        try {
            database.exec(`
                PRAGMA journal_mode = OFF;
                PRAGMA synchronous = OFF;
                PRAGMA temp_store = MEMORY;
                CREATE TABLE property_definitions (
                    parameter_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    scopes_json TEXT NOT NULL,
                    source TEXT,
                    built_in_parameter TEXT,
                    shared_parameter_guid TEXT,
                    parameter_group TEXT,
                    storage_type TEXT,
                    spec_type_id TEXT,
                    unit_type_id TEXT,
                    is_read_only INTEGER,
                    is_visible INTEGER
                );
                CREATE TABLE property_values (
                    property_value_id TEXT PRIMARY KEY,
                    parameter_id TEXT NOT NULL REFERENCES property_definitions(parameter_id),
                    raw_value_json TEXT NOT NULL,
                    display_value TEXT,
                    UNIQUE(parameter_id, raw_value_json, display_value)
                );
                CREATE TABLE property_sets (
                    property_set_id TEXT PRIMARY KEY,
                    scope TEXT NOT NULL,
                    signature TEXT NOT NULL UNIQUE
                );
                CREATE TABLE property_set_values (
                    property_set_id TEXT NOT NULL REFERENCES property_sets(property_set_id),
                    property_value_id TEXT NOT NULL REFERENCES property_values(property_value_id),
                    PRIMARY KEY(property_set_id, property_value_id)
                );
                CREATE TABLE types (
                    type_id TEXT PRIMARY KEY,
                    source_type_id TEXT NOT NULL,
                    family_name TEXT,
                    name TEXT,
                    property_set_id TEXT NOT NULL REFERENCES property_sets(property_set_id)
                );
                CREATE TABLE elements (
                    logical_element_id TEXT PRIMARY KEY,
                    source_element_id TEXT NOT NULL UNIQUE,
                    type_id TEXT REFERENCES types(type_id),
                    category TEXT NOT NULL,
                    family TEXT,
                    type_name TEXT,
                    instance_property_set_id TEXT NOT NULL REFERENCES property_sets(property_set_id)
                );
                CREATE TABLE levels (
                    level_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    elevation REAL NOT NULL,
                    source TEXT NOT NULL,
                    method TEXT NOT NULL
                );
                CREATE TABLE render_objects (
                    render_object_id TEXT PRIMARY KEY,
                    logical_element_id TEXT NOT NULL REFERENCES elements(logical_element_id),
                    source_element_id TEXT NOT NULL REFERENCES elements(source_element_id),
                    viewer_object_id TEXT NOT NULL,
                    source_type TEXT NOT NULL
                );
                CREATE TABLE definition_value_index (
                    parameter_id TEXT NOT NULL REFERENCES property_definitions(parameter_id),
                    property_value_id TEXT NOT NULL REFERENCES property_values(property_value_id),
                    PRIMARY KEY(parameter_id, property_value_id)
                );
                CREATE TABLE facet_index (
                    facet TEXT NOT NULL,
                    value TEXT NOT NULL,
                    source_element_id TEXT NOT NULL REFERENCES elements(source_element_id),
                    PRIMARY KEY(facet, value, source_element_id)
                );
                CREATE INDEX property_values_parameter_idx ON property_values(parameter_id);
                CREATE INDEX property_set_values_value_idx ON property_set_values(property_value_id);
                CREATE INDEX elements_type_idx ON elements(type_id);
                CREATE INDEX render_objects_viewer_idx ON render_objects(viewer_object_id);
                CREATE INDEX facet_index_lookup_idx ON facet_index(facet, value);
            `);
            const definitions = new Map(source.parameterDefinitions.map((definition) => [definition.parameterId, definition]));
            const insertDefinition = database.prepare(`
                INSERT INTO property_definitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertValue = database.prepare(`
                INSERT OR IGNORE INTO property_values VALUES (?, ?, ?, ?)
            `);
            const insertDefinitionValue = database.prepare(`
                INSERT OR IGNORE INTO definition_value_index VALUES (?, ?)
            `);
            const insertSet = database.prepare(`INSERT OR IGNORE INTO property_sets VALUES (?, ?, ?)`);
            const insertSetValue = database.prepare(`INSERT OR IGNORE INTO property_set_values VALUES (?, ?)`);
            const insertType = database.prepare(`INSERT INTO types VALUES (?, ?, ?, ?, ?)`);
            const insertElement = database.prepare(`INSERT INTO elements VALUES (?, ?, ?, ?, ?, ?, ?)`);
            const insertFacet = database.prepare(`INSERT OR IGNORE INTO facet_index VALUES (?, ?, ?)`);
            const insertRenderObject = database.prepare(`INSERT INTO render_objects VALUES (?, ?, ?, ?, ?)`);

            database.exec("BEGIN");
            for (const definition of source.parameterDefinitions) {
                insertDefinition.run(
                    definition.parameterId,
                    definition.name,
                    json(definition.scopes ?? []),
                    text(definition.source),
                    text(definition.builtInParameter),
                    text(definition.sharedParameterGuid),
                    text(definition.parameterGroup),
                    text(definition.storageType),
                    text(definition.specTypeId),
                    text(definition.unitTypeId),
                    definition.isReadOnly === undefined ? null : Number(definition.isReadOnly),
                    definition.isVisible === undefined ? null : Number(definition.isVisible),
                );
            }

            const propertySetFor = (scope: "instance" | "type", values: RevitSourceParameterValue[]): string => {
                const valueIds = values.map((value) => {
                    if (!definitions.has(value.parameterId)) {
                        throw new Error(`Source metadata references unknown parameter definition: ${value.parameterId}`);
                    }
                    const rawValue = json(value.rawValue);
                    const displayValue = text(value.displayValue);
                    const propertyValueId = `pv:${digest(value.parameterId, rawValue, displayValue ?? "")}`;
                    insertValue.run(propertyValueId, value.parameterId, rawValue, displayValue);
                    insertDefinitionValue.run(value.parameterId, propertyValueId);
                    return propertyValueId;
                }).sort();
                const signature = json({ scope, valueIds });
                const propertySetId = `ps:${digest(signature)}`;
                insertSet.run(propertySetId, scope, signature);
                for (const propertyValueId of valueIds) insertSetValue.run(propertySetId, propertyValueId);
                return propertySetId;
            };

            for (const type of source.types) {
                insertType.run(
                    type.typeId,
                    type.sourceTypeId,
                    text(type.familyName),
                    text(type.name),
                    propertySetFor("type", type.parameterValues),
                );
            }

            for (const element of source.elements) {
                const propertySetId = propertySetFor("instance", element.instanceParameterValues);
                insertElement.run(
                    element.logicalElementId,
                    element.sourceElementId,
                    text(element.typeId),
                    element.category ?? "Uncategorized",
                    text(element.family),
                    text(element.type),
                    propertySetId,
                );
                for (const [facet, value] of [["category", element.category], ["family", element.family], ["type", element.type]] as const) {
                    if (value) insertFacet.run(facet, value, element.sourceElementId);
                }
            }
            const sourceByLogicalId = new Map(source.elements.map((element) => [element.logicalElementId, element]));
            const renderObjects = objectMap?.renderObjects ?? source.elements.map((element) => ({
                renderObjectId: `legacy:${element.sourceElementId}`,
                logicalElementId: element.logicalElementId,
                sourceElementId: element.sourceElementId,
                sourceType: "revit.element",
                geometry: { legacyNodeName: element.sourceElementId },
            }));
            for (const renderObject of renderObjects) {
                const sourceElement = sourceByLogicalId.get(renderObject.logicalElementId);
                if (!sourceElement || sourceElement.sourceElementId !== renderObject.sourceElementId) {
                    throw new Error(`Object map render object ${renderObject.renderObjectId} does not match source metadata.`);
                }
                insertRenderObject.run(
                    renderObject.renderObjectId,
                    renderObject.logicalElementId,
                    renderObject.sourceElementId,
                    renderObject.geometry?.legacyNodeName || renderObject.sourceElementId,
                    renderObject.sourceType,
                );
            }
            database.exec("COMMIT");
            database.exec("VACUUM");

            const after = process.memoryUsage();
            const stats: CanonicalPropertyStoreStats = {
                storeVersion: 1,
                sourceKind: "revit",
                sourceBytes,
                viewerBootstrapBytes,
                databaseBytes: fs.statSync(databasePath).size,
                processingMilliseconds: performance.now() - startedAt,
                heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
                rssDeltaBytes: after.rss - before.rss,
                definitions: count(database, "property_definitions"),
                propertyValues: count(database, "property_values"),
                propertySets: count(database, "property_sets"),
                types: count(database, "types"),
                elements: count(database, "elements"),
                renderObjects: count(database, "render_objects"),
                levels: count(database, "levels"),
            };
            fs.writeFileSync(
                path.join(directory, CanonicalPropertyStore.manifestFilename),
                `${JSON.stringify(stats, null, 2)}\n`,
                "utf8",
            );
            return stats;
        } catch (error) {
            try { database.exec("ROLLBACK"); } catch { /* no active transaction */ }
            throw error;
        } finally {
            database.close();
        }
    }

    getElementProperties(databasePath: string, sourceElementId: string): StoredElementProperties | undefined {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const element = database.prepare(`
                SELECT logical_element_id, source_element_id, type_id, category, family, type_name, instance_property_set_id
                FROM elements WHERE source_element_id = ?
            `).get(sourceElementId) as {
                logical_element_id: string; source_element_id: string; type_id: string | null; category: string;
                family: string | null; type_name: string | null; instance_property_set_id: string;
            } | undefined;
            if (!element) return undefined;
            const properties = database.prepare(`
                SELECT definition.parameter_id, definition.name, definition.storage_type, definition.spec_type_id, definition.unit_type_id,
                       value.raw_value_json, value.display_value, assignment.scope
                FROM (
                    SELECT ? AS property_set_id, 'instance' AS scope
                    UNION ALL
                    SELECT types.property_set_id, 'type' AS scope FROM types WHERE types.type_id = ?
                ) assignment
                JOIN property_set_values set_value ON set_value.property_set_id = assignment.property_set_id
                JOIN property_values value ON value.property_value_id = set_value.property_value_id
                JOIN property_definitions definition ON definition.parameter_id = value.parameter_id
                ORDER BY assignment.scope, definition.name, definition.parameter_id
            `).all(element.instance_property_set_id, element.type_id) as Array<{
                parameter_id: string; name: string; storage_type: string | null; spec_type_id: string | null;
                unit_type_id: string | null; raw_value_json: string; display_value: string | null; scope: "instance" | "type";
            }>;
            return {
                logicalElementId: element.logical_element_id,
                sourceElementId: element.source_element_id,
                typeId: element.type_id,
                category: element.category,
                family: element.family,
                type: element.type_name,
                properties: properties.map((property) => ({
                    parameterId: property.parameter_id,
                    name: property.name,
                    scope: property.scope,
                    rawValue: JSON.parse(property.raw_value_json) as unknown,
                    displayValue: property.display_value,
                    storageType: property.storage_type,
                    specTypeId: property.spec_type_id,
                    unitTypeId: property.unit_type_id,
                })),
            };
        } finally {
            database.close();
        }
    }

    getFacetValues(databasePath: string, facet: "category" | "family" | "type"): string[] {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            return (database.prepare(`SELECT DISTINCT value FROM facet_index WHERE facet = ? ORDER BY value`).all(facet) as Array<{ value: string }>)
                .map((entry) => entry.value);
        } finally {
            database.close();
        }
    }

    getElementPropertiesForViewerObject(databasePath: string, viewerObjectId: string): StoredElementProperties | undefined {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const match = database.prepare(`
                SELECT source_element_id FROM render_objects WHERE viewer_object_id = ? LIMIT 1
            `).get(viewerObjectId) as { source_element_id: string } | undefined;
            return match ? this.getElementProperties(databasePath, match.source_element_id) : undefined;
        } finally {
            database.close();
        }
    }
}
