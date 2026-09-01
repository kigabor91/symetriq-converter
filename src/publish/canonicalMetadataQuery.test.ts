import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { queryCanonicalMetadataProperty } from "./canonicalMetadataQuery.js";

test("IFC canonical metadata returns source-neutral values and render-object matches", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-ifc-query-"));
    try {
        const metadataPath = path.join(directory, "model.metadata.json");
        fs.writeFileSync(metadataPath, JSON.stringify({
            elements: {
                "ifc-1": { propertySetIds: ["pset-a"], identity: { category: "Pipes", type: "Pipe" } },
                "ifc-2": { propertySetIds: ["pset-b"], identity: { category: "Pipes", type: "Pipe" } },
                "ifc-3": { propertySetIds: ["pset-c"], identity: { category: "Ducts", type: "Duct" } },
            },
            propertySets: {
                "pset-a": { name: "Pset_PipeCommon", properties: [{ name: "System", value: "CHW" }] },
                "pset-b": { name: "Pset_PipeCommon", properties: [{ name: "System", value: "CHW" }] },
                "pset-c": { name: "Pset_PipeCommon", properties: [{ name: "System", value: "SA" }] },
            },
        }));
        const definitionId = "canonical:instance:Pset_PipeCommon:System";
        const values = queryCanonicalMetadataProperty(metadataPath, definitionId).values;
        assert.deepEqual(values, [
            { valueId: "value:CHW", displayValue: "CHW", count: 2 },
            { valueId: "value:SA", displayValue: "SA", count: 1 },
        ]);
        assert.deepEqual(queryCanonicalMetadataProperty(metadataPath, definitionId, ["value:CHW"]).rendererObjectIds, ["ifc-1", "ifc-2"]);
        assert.deepEqual(queryCanonicalMetadataProperty(metadataPath, definitionId, ["value:CHW", "value:SA"]).rendererObjectIds, ["ifc-1", "ifc-2", "ifc-3"]);
        assert.deepEqual(queryCanonicalMetadataProperty(metadataPath, definitionId, ["value:none"]).rendererObjectIds, []);
        assert.deepEqual(queryCanonicalMetadataProperty(metadataPath, "canonical:facet:category").values, [
            { valueId: "value:Ducts", displayValue: "Ducts", count: 1 },
            { valueId: "value:Pipes", displayValue: "Pipes", count: 2 },
        ]);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
