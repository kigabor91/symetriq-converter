import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PublishObjectMapV1, RevitSourceMetadataV1, RevitSourceParameterDefinition, RevitSourceParameterValue } from "./revitSourceMetadata.js";

export interface PropertyAnalysisEntry { parameterId: string; name: string; occurrences: number; sourceBytes: number; }
export interface CanonicalPropertyStoreAnalysis {
    definitionCount: number; uniquePropertyNames: number; uniquePropertyValues: number;
    instancePropertyCount: number; typePropertyCount: number;
    topFrequentProperties: PropertyAnalysisEntry[]; topLargestProperties: PropertyAnalysisEntry[];
    sqlite: { pageSize: number; pageCount: number; freelistPages: number; dataBytes: number; indexBytes: number; otherBytes: number };
}
export interface CanonicalPropertyStoreStats {
    storeVersion: 2; sourceKind: "revit"; sourceBytes: number; viewerBootstrapBytes: number; databaseBytes: number;
    processingMilliseconds: number; heapUsedDeltaBytes: number; rssDeltaBytes: number;
    definitions: number; propertyValues: number; propertySets: number; types: number; elements: number; renderObjects: number; levels: number;
    analysis: CanonicalPropertyStoreAnalysis;
}
export interface StoredCanonicalProperty {
    parameterId: string; name: string; scope: "instance" | "type"; rawValue: unknown; displayValue: string | null;
    storageType: string | null; specTypeId: string | null; unitTypeId: string | null;
}
export interface StoredElementProperties {
    logicalElementId: string; sourceElementId: string; typeId: string | null; category: string;
    family: string | null; type: string | null; properties: StoredCanonicalProperty[];
}

/** Source-neutral definition record consumed by the Viewer configuration UI. */
export interface CanonicalPropertyDefinition {
    propertyDefinitionId: string;
    propertySetName: string;
    displayName: string;
    valueType: string | null;
    unit: string | null;
    scope: "instance" | "type";
}
export interface CanonicalPropertyValue { valueId: string; displayValue: string; count: number; }

function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function json(value: unknown): string { return JSON.stringify(value) ?? "null"; }
function hash(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function count(database: DatabaseSync, table: string): number { return Number((database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value); }
function defaultDisplayValue(rawValue: unknown): string | null { return rawValue === null || rawValue === undefined ? null : String(rawValue); }

function pageUsage(database: DatabaseSync): CanonicalPropertyStoreAnalysis["sqlite"] {
    const pageSize = Number((database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    const pageCount = Number((database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const freelistPages = Number((database.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
    try {
        const rows = database.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all() as Array<{ name: string; bytes: number }>;
        const tables = new Set(["property_definitions", "string_dictionary", "property_values", "property_sets", "property_set_values", "types", "elements", "levels", "render_objects", "facet_index"]);
        const dataBytes = rows.filter((row) => tables.has(row.name)).reduce((sum, row) => sum + Number(row.bytes), 0);
        const indexBytes = rows.filter((row) => !tables.has(row.name) && row.name !== "sqlite_schema").reduce((sum, row) => sum + Number(row.bytes), 0);
        return { pageSize, pageCount, freelistPages, dataBytes, indexBytes, otherBytes: Math.max(0, pageSize * pageCount - dataBytes - indexBytes) };
    } catch { return { pageSize, pageCount, freelistPages, dataBytes: 0, indexBytes: 0, otherBytes: pageSize * pageCount }; }
}

function sourceAnalysis(source: RevitSourceMetadataV1): Omit<CanonicalPropertyStoreAnalysis, "uniquePropertyValues" | "sqlite"> {
    const definitions = new Map(source.parameterDefinitions.map((definition) => [definition.parameterId, definition]));
    const entries = new Map<string, PropertyAnalysisEntry>();
    let instancePropertyCount = 0;
    let typePropertyCount = 0;
    const record = (value: RevitSourceParameterValue, scope: "instance" | "type") => {
        const previous = entries.get(value.parameterId) ?? { parameterId: value.parameterId, name: definitions.get(value.parameterId)?.name ?? value.parameterId, occurrences: 0, sourceBytes: 0 };
        previous.occurrences += 1;
        previous.sourceBytes += Buffer.byteLength(json(value.rawValue)) + Buffer.byteLength(value.displayValue ?? "");
        entries.set(value.parameterId, previous);
        if (scope === "instance") instancePropertyCount += 1; else typePropertyCount += 1;
    };
    source.elements.forEach((element) => element.instanceParameterValues.forEach((value) => record(value, "instance")));
    source.types.forEach((type) => type.parameterValues.forEach((value) => record(value, "type")));
    const all = [...entries.values()];
    return {
        definitionCount: source.parameterDefinitions.length,
        uniquePropertyNames: new Set(source.parameterDefinitions.map((definition) => definition.name)).size,
        instancePropertyCount, typePropertyCount,
        topFrequentProperties: [...all].sort((left, right) => right.occurrences - left.occurrences).slice(0, 20),
        topLargestProperties: [...all].sort((left, right) => right.sourceBytes - left.sourceBytes).slice(0, 20),
    };
}

/** Hub-owned property database with compact integer relationship keys. */
export class CanonicalPropertyStore {
    static readonly databaseFilename = "canonical-property-store.sqlite";
    static readonly manifestFilename = "canonical-property-store.manifest.json";
    static readonly analysisFilename = "canonical-property-store.analysis.json";

    build(source: RevitSourceMetadataV1, directory: string, sourceBytes: number, viewerBootstrapBytes = 0, objectMap?: PublishObjectMapV1): CanonicalPropertyStoreStats {
        fs.mkdirSync(directory, { recursive: true });
        const databasePath = path.join(directory, CanonicalPropertyStore.databaseFilename);
        fs.rmSync(databasePath, { force: true });
        const before = process.memoryUsage();
        const startedAt = performance.now();
        const database = new DatabaseSync(databasePath);
        try {
            database.exec(`
                PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;
                CREATE TABLE property_definitions (definition_key INTEGER PRIMARY KEY, parameter_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, scopes_json TEXT NOT NULL, source TEXT, built_in_parameter TEXT, shared_parameter_guid TEXT, parameter_group TEXT, storage_type TEXT, spec_type_id TEXT, unit_type_id TEXT, is_read_only INTEGER, is_visible INTEGER);
                CREATE TABLE string_dictionary (string_id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE);
                CREATE TABLE property_values (property_value_id INTEGER PRIMARY KEY, definition_key INTEGER NOT NULL REFERENCES property_definitions(definition_key), raw_value_json TEXT NOT NULL, display_string_id INTEGER REFERENCES string_dictionary(string_id), UNIQUE(definition_key, raw_value_json, display_string_id));
                CREATE TABLE property_sets (property_set_id INTEGER PRIMARY KEY, scope TEXT NOT NULL, signature_hash BLOB NOT NULL UNIQUE);
                CREATE TABLE property_set_values (property_set_id INTEGER NOT NULL REFERENCES property_sets(property_set_id), property_value_id INTEGER NOT NULL REFERENCES property_values(property_value_id), PRIMARY KEY(property_set_id, property_value_id)) WITHOUT ROWID;
                CREATE TABLE types (type_id TEXT PRIMARY KEY, source_type_id TEXT NOT NULL, family_name TEXT, name TEXT, property_set_id INTEGER NOT NULL REFERENCES property_sets(property_set_id));
                CREATE TABLE elements (logical_element_id TEXT PRIMARY KEY, source_element_id TEXT NOT NULL UNIQUE, type_id TEXT REFERENCES types(type_id), category TEXT NOT NULL, family TEXT, type_name TEXT, instance_property_set_id INTEGER NOT NULL REFERENCES property_sets(property_set_id));
                CREATE TABLE levels (level_id TEXT PRIMARY KEY, name TEXT NOT NULL, elevation REAL NOT NULL, source TEXT NOT NULL, method TEXT NOT NULL);
                CREATE TABLE render_objects (render_object_id TEXT PRIMARY KEY, logical_element_id TEXT NOT NULL REFERENCES elements(logical_element_id), source_element_id TEXT NOT NULL REFERENCES elements(source_element_id), viewer_object_id TEXT NOT NULL, source_type TEXT NOT NULL);
                CREATE TABLE facet_index (facet TEXT NOT NULL, value TEXT NOT NULL, source_element_id TEXT NOT NULL REFERENCES elements(source_element_id), PRIMARY KEY(facet, value, source_element_id)) WITHOUT ROWID;
                CREATE INDEX property_values_definition_idx ON property_values(definition_key);
                CREATE INDEX property_set_values_value_idx ON property_set_values(property_value_id);
                CREATE INDEX elements_type_idx ON elements(type_id);
                CREATE INDEX render_objects_viewer_idx ON render_objects(viewer_object_id);
                CREATE INDEX facet_index_lookup_idx ON facet_index(facet, value);
            `);
            const definitions = new Map(source.parameterDefinitions.map((definition) => [definition.parameterId, definition]));
            const definitionKeys = new Map<string, number>();
            const stringIds = new Map<string, number>();
            const propertyValueIds = new Map<string, number>();
            const propertySetIds = new Map<string, number>();
            const insertDefinition = database.prepare("INSERT INTO property_definitions VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            const findDefinition = database.prepare("SELECT definition_key FROM property_definitions WHERE parameter_id = ?");
            const insertString = database.prepare("INSERT OR IGNORE INTO string_dictionary VALUES (NULL, ?)");
            const findString = database.prepare("SELECT string_id FROM string_dictionary WHERE value = ?");
            const insertValue = database.prepare("INSERT OR IGNORE INTO property_values VALUES (NULL, ?, ?, ?)");
            const findValue = database.prepare("SELECT property_value_id FROM property_values WHERE definition_key = ? AND raw_value_json = ? AND display_string_id IS ?");
            const insertSet = database.prepare("INSERT OR IGNORE INTO property_sets VALUES (NULL, ?, ?)");
            const findSet = database.prepare("SELECT property_set_id FROM property_sets WHERE signature_hash = ?");
            const insertSetValue = database.prepare("INSERT OR IGNORE INTO property_set_values VALUES (?, ?)");
            const insertLevel = database.prepare("INSERT INTO levels VALUES (?, ?, ?, ?, ?)");
            const insertType = database.prepare("INSERT INTO types VALUES (?, ?, ?, ?, ?)");
            const insertElement = database.prepare("INSERT INTO elements VALUES (?, ?, ?, ?, ?, ?, ?)");
            const insertFacet = database.prepare("INSERT OR IGNORE INTO facet_index VALUES (?, ?, ?)");
            const insertRenderObject = database.prepare("INSERT INTO render_objects VALUES (?, ?, ?, ?, ?)");
            database.exec("BEGIN");
            (source.levels ?? []).forEach((level) => insertLevel.run(level.id, level.name, level.elevation, level.source, level.method));
            source.parameterDefinitions.forEach((definition) => {
                insertDefinition.run(definition.parameterId, definition.name, json(definition.scopes ?? []), text(definition.source), text(definition.builtInParameter), text(definition.sharedParameterGuid), text(definition.parameterGroup), text(definition.storageType), text(definition.specTypeId), text(definition.unitTypeId), definition.isReadOnly === undefined ? null : Number(definition.isReadOnly), definition.isVisible === undefined ? null : Number(definition.isVisible));
                definitionKeys.set(definition.parameterId, Number((findDefinition.get(definition.parameterId) as { definition_key: number }).definition_key));
            });
            const stringIdFor = (value: string): number => {
                const cached = stringIds.get(value); if (cached !== undefined) return cached;
                insertString.run(value); const id = Number((findString.get(value) as { string_id: number }).string_id); stringIds.set(value, id); return id;
            };
            const valueIdFor = (value: RevitSourceParameterValue): number => {
                const definitionKey = definitionKeys.get(value.parameterId);
                if (definitionKey === undefined || !definitions.has(value.parameterId)) throw new Error(`Source metadata references unknown parameter definition: ${value.parameterId}`);
                const raw = json(value.rawValue); const display = text(value.displayValue);
                const displayId = display && display !== defaultDisplayValue(value.rawValue) ? stringIdFor(display) : null;
                const cacheKey = `${definitionKey}\u0000${raw}\u0000${displayId ?? ""}`;
                const cached = propertyValueIds.get(cacheKey); if (cached !== undefined) return cached;
                insertValue.run(definitionKey, raw, displayId);
                const id = Number((findValue.get(definitionKey, raw, displayId) as { property_value_id: number }).property_value_id);
                propertyValueIds.set(cacheKey, id); return id;
            };
            const propertySetFor = (scope: "instance" | "type", values: RevitSourceParameterValue[]): number => {
                const valueIds = values.map(valueIdFor).sort((left, right) => left - right);
                const signatureHash = hash(`${scope}\u0000${valueIds.join(",")}`);
                const key = signatureHash.toString("hex"); const cached = propertySetIds.get(key); if (cached !== undefined) return cached;
                insertSet.run(scope, signatureHash); const id = Number((findSet.get(signatureHash) as { property_set_id: number }).property_set_id);
                propertySetIds.set(key, id); valueIds.forEach((valueId) => insertSetValue.run(id, valueId)); return id;
            };
            source.types.forEach((type) => insertType.run(type.typeId, type.sourceTypeId, text(type.familyName), text(type.name), propertySetFor("type", type.parameterValues)));
            source.elements.forEach((element) => {
                const propertySetId = propertySetFor("instance", element.instanceParameterValues);
                insertElement.run(element.logicalElementId, element.sourceElementId, text(element.typeId), element.category ?? "Uncategorized", text(element.family), text(element.type), propertySetId);
                ([ ["category", element.category], ["family", element.family], ["type", element.type] ] as const).forEach(([facet, value]) => { if (value) insertFacet.run(facet, value, element.sourceElementId); });
            });
            const sourceByLogicalId = new Map(source.elements.map((element) => [element.logicalElementId, element]));
            const renderObjects = objectMap?.renderObjects ?? source.elements.map((element) => ({ renderObjectId: `legacy:${element.sourceElementId}`, logicalElementId: element.logicalElementId, sourceElementId: element.sourceElementId, sourceType: "revit.element", geometry: { legacyNodeName: element.sourceElementId } }));
            renderObjects.forEach((renderObject) => {
                const sourceElement = sourceByLogicalId.get(renderObject.logicalElementId);
                if (!sourceElement || sourceElement.sourceElementId !== renderObject.sourceElementId) throw new Error(`Object map render object ${renderObject.renderObjectId} does not match source metadata.`);
                insertRenderObject.run(renderObject.renderObjectId, renderObject.logicalElementId, renderObject.sourceElementId, renderObject.geometry?.legacyNodeName || renderObject.sourceElementId, renderObject.sourceType);
            });
            database.exec("COMMIT"); database.exec("VACUUM");
            const after = process.memoryUsage();
            const analysis: CanonicalPropertyStoreAnalysis = { ...sourceAnalysis(source), uniquePropertyValues: count(database, "property_values"), sqlite: pageUsage(database) };
            const stats: CanonicalPropertyStoreStats = { storeVersion: 2, sourceKind: "revit", sourceBytes, viewerBootstrapBytes, databaseBytes: fs.statSync(databasePath).size, processingMilliseconds: performance.now() - startedAt, heapUsedDeltaBytes: after.heapUsed - before.heapUsed, rssDeltaBytes: after.rss - before.rss, definitions: count(database, "property_definitions"), propertyValues: analysis.uniquePropertyValues, propertySets: count(database, "property_sets"), types: count(database, "types"), elements: count(database, "elements"), renderObjects: count(database, "render_objects"), levels: count(database, "levels"), analysis };
            fs.writeFileSync(path.join(directory, CanonicalPropertyStore.manifestFilename), `${JSON.stringify(stats, null, 2)}\n`, "utf8");
            fs.writeFileSync(path.join(directory, CanonicalPropertyStore.analysisFilename), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
            return stats;
        } catch (error) { try { database.exec("ROLLBACK"); } catch { /* no active transaction */ } throw error; }
        finally { database.close(); }
    }

    getElementProperties(databasePath: string, sourceElementId: string): StoredElementProperties | undefined {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const element = database.prepare("SELECT logical_element_id, source_element_id, type_id, category, family, type_name, instance_property_set_id FROM elements WHERE source_element_id = ?").get(sourceElementId) as { logical_element_id: string; source_element_id: string; type_id: string | null; category: string; family: string | null; type_name: string | null; instance_property_set_id: number } | undefined;
            if (!element) return undefined;
            const rows = database.prepare(`SELECT definition.parameter_id, definition.name, definition.storage_type, definition.spec_type_id, definition.unit_type_id, value.raw_value_json, dictionary.value AS display_value, assignment.scope FROM (SELECT ? AS property_set_id, 'instance' AS scope UNION ALL SELECT types.property_set_id, 'type' AS scope FROM types WHERE types.type_id = ?) assignment JOIN property_set_values set_value ON set_value.property_set_id = assignment.property_set_id JOIN property_values value ON value.property_value_id = set_value.property_value_id JOIN property_definitions definition ON definition.definition_key = value.definition_key LEFT JOIN string_dictionary dictionary ON dictionary.string_id = value.display_string_id ORDER BY assignment.scope, definition.name, definition.parameter_id`).all(element.instance_property_set_id, element.type_id) as Array<{ parameter_id: string; name: string; storage_type: string | null; spec_type_id: string | null; unit_type_id: string | null; raw_value_json: string; display_value: string | null; scope: "instance" | "type" }>;
            return { logicalElementId: element.logical_element_id, sourceElementId: element.source_element_id, typeId: element.type_id, category: element.category, family: element.family, type: element.type_name, properties: rows.map((row) => { const rawValue = JSON.parse(row.raw_value_json) as unknown; return { parameterId: row.parameter_id, name: row.name, scope: row.scope, rawValue, displayValue: row.display_value ?? defaultDisplayValue(rawValue), storageType: row.storage_type, specTypeId: row.spec_type_id, unitTypeId: row.unit_type_id }; }) };
        } finally { database.close(); }
    }

    getElementPropertiesForRenderObject(databasePath: string, renderObjectId: string): StoredElementProperties | undefined {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        let sourceElementId: string | undefined;
        try { sourceElementId = (database.prepare("SELECT source_element_id FROM render_objects WHERE render_object_id = ?").get(renderObjectId) as { source_element_id: string } | undefined)?.source_element_id; }
        finally { database.close(); }
        return sourceElementId ? this.getElementProperties(databasePath, sourceElementId) : undefined;
    }

    getPropertyDefinitions(databasePath: string): CanonicalPropertyDefinition[] {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const rows = database.prepare(`
                SELECT DISTINCT definition.parameter_id, definition.name, definition.storage_type, definition.unit_type_id, sets.scope
                FROM property_definitions definition
                JOIN property_values value ON value.definition_key = definition.definition_key
                JOIN property_set_values set_value ON set_value.property_value_id = value.property_value_id
                JOIN property_sets sets ON sets.property_set_id = set_value.property_set_id
                ORDER BY sets.scope, definition.name, definition.parameter_id
            `).all() as Array<{ parameter_id: string; name: string; storage_type: string | null; unit_type_id: string | null; scope: "instance" | "type" }>;
            return [
                ...rows.map((row) => ({
                propertyDefinitionId: `canonical:${row.scope}:${row.parameter_id}`,
                propertySetName: row.scope === "instance" ? "Instance Parameters" : "Type Parameters",
                displayName: row.name,
                valueType: row.storage_type,
                unit: row.unit_type_id,
                scope: row.scope,
                })),
                ...(count(database, "elements") === 0 ? [] : (["category", "family", "type"] as const).map((facet) => ({
                    propertyDefinitionId: `canonical:facet:${facet}`,
                    propertySetName: "Identity",
                    displayName: facet.charAt(0).toUpperCase() + facet.slice(1),
                    valueType: "string",
                    unit: null,
                    scope: "instance" as const,
                }))),
            ];
        } finally { database.close(); }
    }

    getPropertyValues(databasePath: string, definitionId: string): CanonicalPropertyValue[] {
        const facet = /^canonical:facet:(category|family|type)$/.exec(definitionId)?.[1];
        if (facet) {
            const database = new DatabaseSync(databasePath, { readOnly: true });
            try {
                return (database.prepare(`SELECT e.${facet} AS value, COUNT(DISTINCT e.source_element_id) AS count FROM elements e WHERE e.${facet} IS NOT NULL AND e.${facet} <> '' GROUP BY e.${facet} ORDER BY e.${facet}`).all() as Array<{ value: string; count: number }>).map((row) => ({ valueId: `value:${encodeURIComponent(row.value)}`, displayValue: row.value, count: Number(row.count) }));
            } finally { database.close(); }
        }
        const match = /^canonical:(instance|type):(.+)$/.exec(definitionId);
        if (!match) return [];
        const scope = match[1] as "instance" | "type";
        const parameterId = match[2]!;
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const joins = scope === "instance" ? "JOIN elements e ON e.instance_property_set_id = sets.property_set_id" : "JOIN types t ON t.property_set_id = sets.property_set_id JOIN elements e ON e.type_id = t.type_id";
            const rows = database.prepare(`SELECT value.property_value_id, value.raw_value_json, dictionary.value AS display_value, COUNT(DISTINCT e.source_element_id) AS count FROM property_definitions d JOIN property_values value ON value.definition_key=d.definition_key JOIN property_set_values sv ON sv.property_value_id=value.property_value_id JOIN property_sets sets ON sets.property_set_id=sv.property_set_id ${joins} LEFT JOIN string_dictionary dictionary ON dictionary.string_id=value.display_string_id WHERE d.parameter_id=? AND sets.scope=? GROUP BY value.property_value_id ORDER BY COALESCE(dictionary.value,value.raw_value_json)`).all(parameterId, scope) as Array<{property_value_id:number;raw_value_json:string;display_value:string|null;count:number}>;
            return rows.map((row) => { const raw = JSON.parse(row.raw_value_json) as unknown; return { valueId: `value:${row.property_value_id}`, displayValue: row.display_value ?? defaultDisplayValue(raw) ?? "", count: Number(row.count) }; });
        } finally { database.close(); }
    }

    getMatchingViewerObjectIds(databasePath: string, definitionId: string, valueIds: string[]): string[] {
        const facet = /^canonical:facet:(category|family|type)$/.exec(definitionId)?.[1];
        if (facet) {
            const values = valueIds.map((id) => /^value:(.*)$/.exec(id)?.[1]).filter((value): value is string => value !== undefined).map(decodeURIComponent);
            if (values.length === 0) return [];
            const database = new DatabaseSync(databasePath, { readOnly: true });
            try {
                const marks = values.map(() => "?").join(",");
                return (database.prepare(`SELECT DISTINCT r.viewer_object_id FROM elements e JOIN render_objects r ON r.source_element_id=e.source_element_id WHERE e.${facet} IN (${marks})`).all(...values) as Array<{ viewer_object_id: string }>).map((row) => row.viewer_object_id);
            } finally { database.close(); }
        }
        const match = /^canonical:(instance|type):(.+)$/.exec(definitionId);
        const ids = valueIds.map((id) => Number(/^value:(\d+)$/.exec(id)?.[1])).filter(Number.isInteger);
        if (!match || ids.length === 0) return [];
        const scope = match[1] as "instance" | "type";
        const parameterId = match[2]!;
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const joins = scope === "instance" ? "JOIN elements e ON e.instance_property_set_id = sets.property_set_id" : "JOIN types t ON t.property_set_id = sets.property_set_id JOIN elements e ON e.type_id = t.type_id";
            const marks = ids.map(() => "?").join(",");
            return (database.prepare(`SELECT DISTINCT r.viewer_object_id FROM property_definitions d JOIN property_values value ON value.definition_key=d.definition_key JOIN property_set_values sv ON sv.property_value_id=value.property_value_id JOIN property_sets sets ON sets.property_set_id=sv.property_set_id ${joins} JOIN render_objects r ON r.source_element_id=e.source_element_id WHERE d.parameter_id=? AND sets.scope=? AND value.property_value_id IN (${marks})`).all(parameterId, scope, ...ids) as Array<{viewer_object_id:string}>).map((row) => row.viewer_object_id);
        } finally { database.close(); }
    }

    getFacetValues(databasePath: string, facet: "category" | "family" | "type"): string[] {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try { return (database.prepare("SELECT DISTINCT value FROM facet_index WHERE facet = ? ORDER BY value").all(facet) as Array<{ value: string }>).map((entry) => entry.value); }
        finally { database.close(); }
    }
}
