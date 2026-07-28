import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateMetadataPropertySets, type SymetriqMetadata } from "./metadata.js";

test("metadata property set deduplication preserves element data and property values", () => {
    const metadata: SymetriqMetadata = {
        version: 2,
        elements: {
            "product-a-body": {
                globalId: "element-a",
                type: "IfcWall",
                name: "Wall A",
                propertySetIds: ["property-set-a"],
            },
            "product-b-body": {
                globalId: "element-b",
                type: "IfcWall",
                name: "Wall B",
                propertySetIds: ["property-set-b", "property-set-unique"],
            },
        },
        propertySets: {
            "property-set-a": {
                id: "property-set-a",
                name: "Identity Data",
                type: "IfcPropertySet",
                properties: [{ name: "Family", value: "Wall", type: "IFCLABEL" }],
            },
            "property-set-b": {
                id: "property-set-b",
                name: "Identity Data",
                type: "IfcPropertySet",
                properties: [{ name: "Family", value: "Wall", type: "IFCLABEL" }],
            },
            "property-set-unique": {
                id: "property-set-unique",
                name: "Dimensions",
                type: "IfcPropertySet",
                properties: [{ name: "Height", value: 3, type: "IFCLENGTHMEASURE" }],
            },
        },
        levels: [],
    };

    const { metadata: optimized, stats } = deduplicateMetadataPropertySets(metadata);

    assert.deepEqual(stats, {
        inputPropertySets: 3,
        outputPropertySets: 2,
        deduplicatedPropertySets: 1,
    });
    assert.equal(optimized.elements["product-a-body"]?.globalId, "element-a");
    assert.equal(optimized.elements["product-b-body"]?.name, "Wall B");
    assert.deepEqual(optimized.elements["product-a-body"]?.propertySetIds, ["property-set-a"]);
    assert.deepEqual(optimized.elements["product-b-body"]?.propertySetIds, ["property-set-a", "property-set-unique"]);
    assert.deepEqual(
        optimized.propertySets["property-set-a"]?.properties,
        [{ name: "Family", value: "Wall", type: "IFCLABEL" }],
    );
});
