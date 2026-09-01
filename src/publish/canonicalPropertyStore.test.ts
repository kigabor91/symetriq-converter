import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CanonicalPropertyStore } from "./canonicalPropertyStore.js";
import { PublishMetadataNormalizer } from "./publishMetadataNormalizer.js";
import type { RevitSourceMetadataV1 } from "./revitSourceMetadata.js";

test("canonical property store deduplicates Revit definitions, values and property sets", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-property-store-"));
    try {
        const source: RevitSourceMetadataV1 = {
            version: "1.0",
            sourceKind: "revit",
            parameterDefinitions: [
                { parameterId: "bip:diameter", name: "Diameter", scopes: ["type"], source: "builtIn", storageType: "Double", specTypeId: "length", unitTypeId: "millimeters" },
                { parameterId: "shared:asset", name: "Asset Code", scopes: ["instance"], source: "shared", storageType: "String" },
            ],
            types: [{
                typeId: "revit-type:dn100", sourceTypeId: "type-unique-id", familyName: "Pipe", name: "DN100",
                parameterValues: [{ parameterId: "bip:diameter", rawValue: 0.328084, displayValue: "100 mm" }],
            }],
            elements: ["one", "two"].map((id) => ({
                logicalElementId: `logical-${id}`,
                sourceElementId: `revit-${id}`,
                typeId: "revit-type:dn100",
                category: "Pipes",
                family: "Pipe",
                type: "DN100",
                instanceParameterValues: [{ parameterId: "shared:asset", rawValue: "P-01", displayValue: "P-01" }],
            })),
        };
        const store = new CanonicalPropertyStore();
        const stats = store.build(source, directory, Buffer.byteLength(JSON.stringify(source)));
        const databasePath = path.join(directory, CanonicalPropertyStore.databaseFilename);

        assert.equal(fs.existsSync(databasePath), true);
        assert.equal(stats.definitions, 2);
        assert.equal(stats.propertyValues, 2);
        assert.equal(stats.propertySets, 2);
        assert.equal(stats.types, 1);
        assert.equal(stats.elements, 2);
        assert.equal(stats.analysis.instancePropertyCount, 2);
        assert.equal(stats.analysis.typePropertyCount, 1);
        assert.equal(stats.analysis.topFrequentProperties[0]?.name, "Asset Code");
        assert.ok(stats.databaseBytes > 0);
        assert.deepEqual(store.getFacetValues(databasePath, "category"), ["Pipes"]);
        assert.deepEqual(store.getPropertyDefinitions(databasePath), [
            { propertyDefinitionId: "canonical:instance:shared:asset", propertySetName: "Instance Parameters", displayName: "Asset Code", valueType: "String", unit: null, scope: "instance" },
            { propertyDefinitionId: "canonical:type:bip:diameter", propertySetName: "Type Parameters", displayName: "Diameter", valueType: "Double", unit: "millimeters", scope: "type" },
        ]);
        assert.deepEqual(store.getElementProperties(databasePath, "revit-one"), {
            logicalElementId: "logical-one",
            sourceElementId: "revit-one",
            typeId: "revit-type:dn100",
            category: "Pipes",
            family: "Pipe",
            type: "DN100",
            properties: [
                {
                    parameterId: "shared:asset", name: "Asset Code", scope: "instance", rawValue: "P-01", displayValue: "P-01",
                    storageType: "String", specTypeId: null, unitTypeId: null,
                },
                {
                    parameterId: "bip:diameter", name: "Diameter", scope: "type", rawValue: 0.328084, displayValue: "100 mm",
                    storageType: "Double", specTypeId: "length", unitTypeId: "millimeters",
                },
            ],
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("property definition catalogs are empty for empty metadata and isolated per Store", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-catalog-first-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-catalog-second-"));
    try {
        const store = new CanonicalPropertyStore();
        const empty: RevitSourceMetadataV1 = { version: "1.0", sourceKind: "revit", parameterDefinitions: [], types: [], elements: [] };
        store.build(empty, first, 0);
        assert.deepEqual(store.getPropertyDefinitions(path.join(first, CanonicalPropertyStore.databaseFilename)), []);
        const source: RevitSourceMetadataV1 = {
            ...empty,
            parameterDefinitions: [{ parameterId: "only-second", name: "Second only", scopes: ["instance"], storageType: "String" }],
            elements: [{ logicalElementId: "second", sourceElementId: "second", category: "Generic", instanceParameterValues: [{ parameterId: "only-second", rawValue: "x", displayValue: "x" }] }],
        };
        store.build(source, second, 1);
        assert.equal(store.getPropertyDefinitions(path.join(second, CanonicalPropertyStore.databaseFilename))[0]?.displayName, "Second only");
        assert.deepEqual(store.getPropertyDefinitions(path.join(first, CanonicalPropertyStore.databaseFilename)), []);
    } finally {
        fs.rmSync(first, { recursive: true, force: true });
        fs.rmSync(second, { recursive: true, force: true });
    }
});

test("Revit source projection keeps the Viewer bootstrap small while retaining full retrievable properties", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-property-projection-"));
    try {
        const parameterDefinitions = Array.from({ length: 100 }, (_, index) => ({
            parameterId: `definition:${index}`,
            name: `Parameter ${index}`,
            scopes: ["instance", "type"],
            source: "projectOrFamily",
            storageType: "String",
        }));
        const values = (prefix: string) => parameterDefinitions.map((definition, index) => ({
            parameterId: definition.parameterId,
            rawValue: `${prefix}-${index}`,
            displayValue: `${prefix}-${index}`,
        }));
        const source: RevitSourceMetadataV1 = {
            version: "1.0",
            sourceKind: "revit",
            parameterDefinitions,
            types: [{
                typeId: "revit-type:shared", sourceTypeId: "type-unique", familyName: "Pipe", name: "DN100",
                parameterValues: values("type"),
            }],
            elements: Array.from({ length: 10 }, (_, index) => ({
                logicalElementId: `logical-${index}`,
                sourceElementId: `revit-${index}`,
                typeId: "revit-type:shared",
                category: "Pipes",
                family: "Pipe",
                type: "DN100",
                instanceParameterValues: values("instance"),
            })),
        };
        const sourceBytes = Buffer.byteLength(JSON.stringify(source));
        const bootstrapPath = path.join(directory, "metadata.json");
        const result = new PublishMetadataNormalizer().project(source, sourceBytes, bootstrapPath, directory);
        const store = new CanonicalPropertyStore();

        assert.ok(result.canonicalBytes < sourceBytes / 20);
        assert.equal(result.propertyStore?.definitions, 100);
        assert.equal(result.propertyStore?.propertyValues, 200);
        assert.equal(result.propertyStore?.propertySets, 2);
        assert.equal(result.propertyStore?.elements, 10);
        assert.equal(result.metadata.elements["revit-0"]?.propertySetIds.length, 0);
        assert.equal(
            store.getElementProperties(path.join(directory, CanonicalPropertyStore.databaseFilename), "revit-0")?.properties.length,
            200,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("explicit object map links the current Viewer object identity to the logical property record", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-object-map-store-"));
    try {
        const source: RevitSourceMetadataV1 = {
            version: "1.0", sourceKind: "revit",
            parameterDefinitions: [], types: [],
            elements: [{
                logicalElementId: "logical-1", sourceElementId: "revit-unique-1", category: "Ducts",
                family: "Duct", type: "DN200", instanceParameterValues: [],
            }],
        };
        const objectMap = {
            version: 1 as const,
            packageId: "package-1",
            sourceKind: "revit" as const,
            logicalElements: [{ logicalElementId: "logical-1", sourceElementId: "revit-unique-1", sourceType: "revit.element" }],
            renderObjects: [{
                renderObjectId: "ro-1", logicalElementId: "logical-1", sourceElementId: "revit-unique-1", sourceType: "revit.element",
                geometry: { kind: "gltf-node", nodeIndex: 0, legacyNodeName: "current-xkt-object-id" },
            }],
        };
        const sourceBytes = Buffer.byteLength(JSON.stringify(source));
        const result = new PublishMetadataNormalizer().project(source, sourceBytes, path.join(directory, "metadata.json"), directory, objectMap);
        const store = new CanonicalPropertyStore();
        const databasePath = path.join(directory, CanonicalPropertyStore.databaseFilename);

        assert.ok(result.metadata.elements["current-xkt-object-id"]);
        assert.equal(result.metadata.elements["revit-unique-1"], undefined);
        assert.equal(result.propertyStore?.renderObjects, 1);
        assert.equal(result.metadata.elements["current-xkt-object-id"]?.propertyStore?.renderObjectId, "ro-1");
        assert.equal(store.getElementPropertiesForRenderObject(databasePath, "ro-1")?.logicalElementId, "logical-1");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
