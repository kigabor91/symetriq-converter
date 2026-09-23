import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CanonicalPropertyStore } from "./canonicalPropertyStore.js";
import type { RevitSourceMetadataV1 } from "./revitSourceMetadata.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/property-store-v2/", import.meta.url));
const fixtureSourcePath = path.join(fixtureDirectory, "source-metadata.json");
const fixtureDatabasePath = path.join(fixtureDirectory, CanonicalPropertyStore.databaseFilename);
const fixtureManifestPath = path.join(fixtureDirectory, CanonicalPropertyStore.manifestFilename);
const store = new CanonicalPropertyStore();

function tempDirectory(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-store-v3-")); }
function removeTempDirectory(directory: string): void {
    const target = path.resolve(directory);
    const tempRoot = path.resolve(os.tmpdir());
    if (!target.startsWith(`${tempRoot}${path.sep}`) || !path.basename(target).startsWith("symetriq-store-v3-")) {
        throw new Error(`Refusing to remove non-test directory: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
}
function digest(filePath: string): string { return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function fixtureSource(): RevitSourceMetadataV1 { return JSON.parse(fs.readFileSync(fixtureSourcePath, "utf8")) as RevitSourceMetadataV1; }

test("new Store v3 records actual instance/type usage and excludes the obsolete facet tables", () => {
    const directory = tempDirectory();
    try {
        const source: RevitSourceMetadataV1 = {
            version: "1.0", sourceKind: "revit",
            parameterDefinitions: [
                { parameterId: "instance-only", name: "Instance Only", scopes: ["instance", "type"], storageType: "String" },
                { parameterId: "type-only", name: "Type Only", scopes: ["instance", "type"], storageType: "String" },
                { parameterId: "both", name: "Both", scopes: ["instance"], storageType: "String" },
                { parameterId: "unused", name: "Unused", scopes: ["instance", "type"], storageType: "String" },
                { parameterId: "empty", name: "Empty", scopes: ["instance"], storageType: "String" },
            ],
            types: [{ typeId: "shared-type", sourceTypeId: "source-type", familyName: "Pipe", name: "DN100", parameterValues: [
                { parameterId: "type-only", rawValue: "T", displayValue: "T" },
                { parameterId: "both", rawValue: "By Type", displayValue: "By Type" },
            ] }],
            elements: Array.from({ length: 8 }, (_, index) => ({
                logicalElementId: `logical-${index}`, sourceElementId: `source-${index}`, typeId: "shared-type",
                category: "Pipes", family: "Pipe", type: "DN100",
                instanceParameterValues: [
                    { parameterId: "instance-only", rawValue: "I", displayValue: "I" },
                    { parameterId: "both", rawValue: "Installed", displayValue: "Installed" },
                    { parameterId: "empty", rawValue: index % 2 === 0 ? "" : "filled", displayValue: index % 2 === 0 ? "" : "filled" },
                ],
            })),
        };
        const stats = store.build(source, directory, Buffer.byteLength(JSON.stringify(source)));
        const databasePath = path.join(directory, CanonicalPropertyStore.databaseFilename);
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, CanonicalPropertyStore.manifestFilename), "utf8")) as { storeVersion: number; databaseBytes: number };
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            assert.equal(stats.storeVersion, 3);
            assert.equal(manifest.storeVersion, 3);
            assert.equal(manifest.databaseBytes, fs.statSync(databasePath).size);
            assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
            assert.deepEqual(
                (database.prepare("SELECT parameter_id, usage_mask FROM property_definitions ORDER BY parameter_id").all() as Array<{ parameter_id: string; usage_mask: number }>).map((row) => ({ ...row })),
                [
                    { parameter_id: "both", usage_mask: 3 },
                    { parameter_id: "empty", usage_mask: 1 },
                    { parameter_id: "instance-only", usage_mask: 1 },
                    { parameter_id: "type-only", usage_mask: 2 },
                    { parameter_id: "unused", usage_mask: 0 },
                ],
            );
            assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'facet_index%'").all(), []);
            assert.equal((database.prepare("SELECT COUNT(*) AS n FROM property_set_values").get() as { n: number }).n, 8);
        } finally { database.close(); }
        assert.equal(stats.analysis.instancePropertyCount, 24);
        assert.equal(stats.analysis.typePropertyCount, 2);
        assert.deepEqual(store.getPropertyDefinitions(databasePath), [
            { propertyDefinitionId: "canonical:instance:both", propertySetName: "Instance Parameters", displayName: "Both", valueType: "String", unit: null, scope: "instance" },
            { propertyDefinitionId: "canonical:instance:empty", propertySetName: "Instance Parameters", displayName: "Empty", valueType: "String", unit: null, scope: "instance" },
            { propertyDefinitionId: "canonical:instance:instance-only", propertySetName: "Instance Parameters", displayName: "Instance Only", valueType: "String", unit: null, scope: "instance" },
            { propertyDefinitionId: "canonical:type:both", propertySetName: "Type Parameters", displayName: "Both", valueType: "String", unit: null, scope: "type" },
            { propertyDefinitionId: "canonical:type:type-only", propertySetName: "Type Parameters", displayName: "Type Only", valueType: "String", unit: null, scope: "type" },
            { propertyDefinitionId: "canonical:facet:category", propertySetName: "Identity", displayName: "Category", valueType: "string", unit: null, scope: "instance" },
            { propertyDefinitionId: "canonical:facet:family", propertySetName: "Identity", displayName: "Family", valueType: "string", unit: null, scope: "instance" },
            { propertyDefinitionId: "canonical:facet:type", propertySetName: "Identity", displayName: "Type", valueType: "string", unit: null, scope: "instance" },
        ]);
        assert.deepEqual(store.getPropertyValues(databasePath, "canonical:instance:empty").map((value) => [value.displayValue, value.count]), [["", 4], ["filled", 4]]);
        const typeValue = store.getPropertyValues(databasePath, "canonical:type:type-only")[0]!;
        assert.equal(typeValue.count, 8);
        assert.deepEqual(store.getMatchingViewerObjectIds(databasePath, "canonical:type:type-only", [typeValue.valueId]).sort(), Array.from({ length: 8 }, (_, index) => `source-${index}`));
        assert.equal(store.getElementPropertiesForRenderObject(databasePath, "legacy:source-0")?.properties.length, 5);
    } finally { removeTempDirectory(directory); }
});

test("genuine pre-change v2 Store remains readable and exactly matches new v3 public results", () => {
    const directory = tempDirectory();
    try {
        const source = fixtureSource();
        const fixtureManifest = JSON.parse(fs.readFileSync(fixtureManifestPath, "utf8")) as { storeVersion: number };
        const oldDatabase = new DatabaseSync(fixtureDatabasePath, { readOnly: true });
        try {
            assert.equal(fixtureManifest.storeVersion, 2);
            assert.equal((oldDatabase.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
            assert.equal((oldDatabase.prepare("PRAGMA table_info(property_definitions)").all() as Array<{ name: string }>).some((column) => column.name === "usage_mask"), false);
            assert.equal((oldDatabase.prepare("SELECT COUNT(*) AS n FROM facet_index").get() as { n: number }).n, 6);
        } finally { oldDatabase.close(); }
        const stats = store.build(source, directory, fs.statSync(fixtureSourcePath).size);
        const newDatabasePath = path.join(directory, CanonicalPropertyStore.databaseFilename);
        assert.equal(stats.storeVersion, 3);
        assert.deepEqual(store.getPropertyDefinitions(newDatabasePath), store.getPropertyDefinitions(fixtureDatabasePath));
        for (const sourceElementId of ["source-pipe-1", "source-pipe-2"]) {
            assert.deepEqual(store.getElementProperties(newDatabasePath, sourceElementId), store.getElementProperties(fixtureDatabasePath, sourceElementId));
            assert.deepEqual(store.getElementPropertiesForRenderObject(newDatabasePath, `legacy:${sourceElementId}`), store.getElementPropertiesForRenderObject(fixtureDatabasePath, `legacy:${sourceElementId}`));
        }
        const definitions = store.getPropertyDefinitions(fixtureDatabasePath);
        for (const definition of definitions) {
            const oldValues = store.getPropertyValues(fixtureDatabasePath, definition.propertyDefinitionId);
            assert.deepEqual(store.getPropertyValues(newDatabasePath, definition.propertyDefinitionId), oldValues);
            for (const value of oldValues) {
                assert.deepEqual(
                    store.getMatchingViewerObjectIds(newDatabasePath, definition.propertyDefinitionId, [value.valueId]).sort(),
                    store.getMatchingViewerObjectIds(fixtureDatabasePath, definition.propertyDefinitionId, [value.valueId]).sort(),
                );
            }
        }
        assert.deepEqual(store.getMatchingViewerObjectIds(newDatabasePath, "canonical:facet:type", ["value:DN100"]).sort(), ["source-pipe-1", "source-pipe-2"]);
        assert.deepEqual(store.getMatchingViewerObjectIds(fixtureDatabasePath, "canonical:facet:type", ["value:DN100"]).sort(), ["source-pipe-1", "source-pipe-2"]);
        const database = new DatabaseSync(newDatabasePath, { readOnly: true });
        const oldDatabaseAgain = new DatabaseSync(fixtureDatabasePath, { readOnly: true });
        try {
            for (const table of ["property_definitions", "property_values", "property_sets", "property_set_values", "types", "elements", "render_objects"]) {
                const sql = `SELECT COUNT(*) AS n FROM ${table}`;
                assert.deepEqual(database.prepare(sql).get(), oldDatabaseAgain.prepare(sql).get(), table);
            }
        } finally { database.close(); oldDatabaseAgain.close(); }
    } finally { removeTempDirectory(directory); }
});

test("missing, malformed, unsupported and mismatched Store manifests fail without changing data", () => {
    const directory = tempDirectory();
    try {
        const source = fixtureSource();
        store.build(source, directory, fs.statSync(fixtureSourcePath).size);
        const databasePath = path.join(directory, CanonicalPropertyStore.databaseFilename);
        const manifestPath = path.join(directory, CanonicalPropertyStore.manifestFilename);
        const originalManifest = fs.readFileSync(manifestPath, "utf8");
        const originalDatabaseHash = digest(databasePath);
        const manifest = JSON.parse(originalManifest) as { storeVersion: number; databaseBytes: number };
        fs.writeFileSync(manifestPath, "not json", "utf8");
        assert.throws(() => store.getPropertyDefinitions(databasePath), /manifest is missing or invalid/);
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, storeVersion: 99 }), "utf8");
        assert.throws(() => store.getPropertyDefinitions(databasePath), /Unsupported Property Store version: 99/);
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, storeVersion: 2 }), "utf8");
        assert.throws(() => store.getPropertyDefinitions(databasePath), /manifest\/SQLite version mismatch/);
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, databaseBytes: manifest.databaseBytes + 1 }), "utf8");
        assert.throws(() => store.getPropertyDefinitions(databasePath), /size mismatch/);
        fs.rmSync(manifestPath);
        assert.throws(() => store.getPropertyDefinitions(databasePath), /manifest is missing or invalid/);
        assert.equal(digest(databasePath), originalDatabaseHash);

        const incomplete = path.join(directory, "incomplete");
        fs.mkdirSync(incomplete);
        const incompleteDatabasePath = path.join(incomplete, CanonicalPropertyStore.databaseFilename);
        const partial = new DatabaseSync(incompleteDatabasePath);
        partial.exec("PRAGMA user_version = 3");
        partial.exec("CREATE TABLE property_definitions (definition_key INTEGER PRIMARY KEY)");
        partial.close();
        assert.throws(() => store.getPropertyDefinitions(incompleteDatabasePath), /manifest is missing or invalid/);
        fs.writeFileSync(path.join(incomplete, CanonicalPropertyStore.manifestFilename), JSON.stringify({ storeVersion: 3, databaseBytes: fs.statSync(incompleteDatabasePath).size }), "utf8");
        assert.throws(() => store.getPropertyDefinitions(incompleteDatabasePath), /definition schema does not match version 3/);
        const wrongVersion = new DatabaseSync(incompleteDatabasePath);
        wrongVersion.exec("PRAGMA user_version = 4");
        wrongVersion.close();
        assert.throws(() => store.getPropertyDefinitions(incompleteDatabasePath), /manifest\/SQLite version mismatch/);
    } finally { removeTempDirectory(directory); }
});

test("failed new build removes its partial Store and cannot overwrite an existing published v2 Store", () => {
    const directory = tempDirectory();
    try {
        const source = fixtureSource();
        const badSource: RevitSourceMetadataV1 = {
            ...source,
            elements: [{ ...source.elements[0]!, instanceParameterValues: [{ parameterId: "missing-definition", rawValue: "x" }] }],
        };
        const failed = path.join(directory, "failed");
        assert.throws(() => store.build(badSource, failed, 1), /unknown parameter definition/);
        for (const file of [CanonicalPropertyStore.databaseFilename, CanonicalPropertyStore.manifestFilename, CanonicalPropertyStore.analysisFilename]) {
            assert.equal(fs.existsSync(path.join(failed, file)), false);
        }
        const published = path.join(directory, "published");
        fs.mkdirSync(published);
        const publishedDatabasePath = path.join(published, CanonicalPropertyStore.databaseFilename);
        fs.copyFileSync(fixtureDatabasePath, publishedDatabasePath);
        fs.copyFileSync(fixtureManifestPath, path.join(published, CanonicalPropertyStore.manifestFilename));
        const before = digest(publishedDatabasePath);
        assert.throws(() => store.build(source, published, fs.statSync(fixtureSourcePath).size), /already contains an artifact/);
        assert.equal(digest(publishedDatabasePath), before);
        assert.deepEqual(store.getPropertyDefinitions(publishedDatabasePath), store.getPropertyDefinitions(fixtureDatabasePath));
    } finally { removeTempDirectory(directory); }
});
