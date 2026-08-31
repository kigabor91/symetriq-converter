# Canonical Property Store

## Purpose

The Hub preserves the complete producer-owned `source-metadata.json`, while
the Viewer receives only compact canonical bootstrap metadata. This prevents a
multi-million-property Revit document from becoming a browser bootstrap JSON.

```text
source-metadata.json (complete, immutable Revit input)
  ├─ canonical-property-store.sqlite (Hub-owned, normalized)
  ├─ canonical-property-store.manifest.json (size and processing metrics)
  └─ metadata.json (Viewer bootstrap projection, canonical v2)
```

The current implementation is built only for Revit Source Metadata v1. IFC
continues to write and serve its established canonical `metadata.json` without
entering this Store. The Store schema is source-neutral in naming so an IFC or
future CAD adapter can opt in later without changing the Viewer.

## Storage location and lifecycle

For a publish `{publishId}`, the following files are retained under:

```text
data/publish-workspaces/{publishId}/
```

- `source-metadata.json` — original Copilot input; never rewritten.
- `metadata.json` — compact Viewer canonical metadata, copied by Project
  Update and the only metadata file exposed to the Viewer.
- `canonical-property-store.sqlite` — normalized Hub property store; not
  exposed to the Viewer.
- `canonical-property-store.manifest.json` — Store counts and byte metrics.

`model.glb` is still deleted after a successful publish. The full source
metadata and property store remain available for later property retrieval.

## Data model

The Store is a SQLite database with these normalized relations:

| Table | Purpose | Deduplication key |
|---|---|---|
| `property_definitions` | Revit definition identity, source, scope, storage/spec/unit metadata | `parameter_id` |
| `property_values` | Raw JSON value plus formatted display value | definition + raw JSON + display value |
| `property_sets` | Ordered-independent collection of property values | scope + sorted value-ID signature |
| `property_set_values` | Many-to-many property set / value membership | pair of IDs |
| `types` | Revit type identity and its deduplicated type property set | `type_id` |
| `elements` | Logical/render identity plus compact category/family/type and instance property-set reference | logical ID / source element ID |
| `render_objects` | Publish Package v1 render ID, logical element and current Viewer/XKT object-ID bridge | `render_object_id` |
| `levels` | Reserved canonical spatial level relation | `level_id` |
| `definition_value_index` | Definition → unique value index for future property search/filter | definition + value ID |
| `facet_index` | Category, family and type → element identity index | facet + value + element |

The Source Metadata already stores one definition per document and one type
value set per Revit type. The Store keeps those boundaries and additionally
deduplicates equal property values and equal instance/type property sets.
Property value IDs and property-set IDs are content-addressed SHA-256 IDs, so
deduplication does not depend on source ordering.

## Viewer bootstrap projection

The bootstrap remains the established Viewer `ModelMetadata` v2 shape:

```json
{
  "version": 2,
  "elements": {
    "revit-unique-id": {
      "globalId": "revit-unique-id",
      "type": "Pipes",
      "name": "Pipe Types - DN100",
      "propertySetIds": ["revit:revit-unique-id:identity"]
    }
  },
  "propertySets": {
    "revit:revit-unique-id:identity": {
      "id": "revit:revit-unique-id:identity",
      "name": "Revit Identity",
      "type": "Revit",
      "properties": [
        {"name": "Logical Element ID", "value": "logical-id", "type": "string"},
        {"name": "Revit Unique ID", "value": "revit-unique-id", "type": "string"},
        {"name": "Category", "value": "Pipes", "type": "string"},
        {"name": "Family", "value": "Pipe Types", "type": "string"},
        {"name": "Type", "value": "DN100", "type": "string"}
      ]
    }
  },
  "levels": []
}
```

The key in `elements` remains the XKT local object ID. For the current Revit
pipeline that is the Revit `UniqueId`, because it is the GLB node name and is
preserved by `convert2xkt`. No Revit-specific Viewer code is introduced.

When an `object-map.json` is present, the Store also persists its explicit
`renderObjectId → logicalElementId` relation. During the current compatibility
phase, bootstrap keys still use `geometry.legacyNodeName` because that is the
actual XKT object ID. A future Hub identity adapter can switch that bridge to
`renderObjectId` without changing the stored logical metadata or the Viewer.

Full instance and type parameters are deliberately absent from the bootstrap.
The canonical metadata file is therefore the Viewer bootstrap metadata; there
is no second large Viewer JSON projection.

## Element property retrieval model

`CanonicalPropertyStore.getElementProperties(databasePath, sourceElementId)`
is the internal retrieval seam. It returns one element's full property set:

```ts
{
  logicalElementId,
  sourceElementId,
  typeId,
  category,
  family,
  type,
  properties: [{
    parameterId,
    name,
    scope: "instance" | "type",
    rawValue,
    displayValue,
    storageType,
    specTypeId,
    unitTypeId
  }]
}
```

This is an internal API only. A future REST endpoint can expose it per selected
element without downloading the entire Store or changing the Viewer metadata
contract.

## Property index and future queries

The Store already persists the relationships required for later search and
filter features:

- `facet_index` supports category, family and type value discovery;
- `definition_value_index` supports parameter-definition/value discovery;
- joins from `elements` through instance property sets and type property sets
  support element lookup for a selected property value.

System filtering is intentionally not inferred from localised Revit parameter
names in this sprint. It can be added as a Hub-owned semantic mapping that
indexes selected parameter definitions into a `system` facet.

No REST endpoint, Viewer UI, property search, or property filter is implemented
by this sprint.

## Performance measurement

The durable publish job records:

- source metadata bytes;
- Viewer bootstrap/canonical metadata bytes;
- SQLite Store bytes;
- JSON parse time plus heap/RSS deltas;
- Store build time plus heap/RSS deltas;

The Store manifest records the source/bootstrap/Store byte counts, Store build
time and memory deltas, plus:

- counts for definitions, values, property sets, types, elements and levels.

The source JSON is parsed once per publish. The parsed object is handed to both
the Viewer projection and Store builder, avoiding a second multi-hundred-MB
parse. The Store uses a transaction and on-disk SQLite indexes; the Viewer does
not load the database.

The automated large-shape test verifies that a full parameter graph is
retained in the Store while the bootstrap is less than one fifth of the source
JSON. The next real 455 MB Copilot publish records the production benchmark in
its workspace and publish job; no estimate is substituted for that measurement.

## 003B: on-demand property retrieval and Store analysis

The Viewer bootstrap is intentionally not a property cache. For a Revit
publish it contains one `elements[viewerObjectId]` entry with only scene
identity (`category`, `family`, `type`, logical element ID) and the Hub-owned
`propertyStore.renderObjectId`. It contains no per-element property-set copy.

When the user selects **Show all properties**, the Viewer calls:

```text
GET /api/projects/{projectId}/models/{modelId}/render-objects/{renderObjectId}/properties
```

The backend resolves `renderObjectId -> logicalElementId -> property store`.
The `renderObjectId` is the explicit Package v1 object-map identifier. The
Viewer does not use `node.name` as a property lookup key. The temporary XKT
viewer object ID is used only to find its bootstrap entry, which already holds
the authoritative `renderObjectId`.

The endpoint returns separate canonical **Revit Instance Parameters** and
**Revit Type Parameters** sets, including display value, raw value, parameter
ID and source unit/spec information. It returns `404` for IFC or older
published models that do not have a Property Store; their existing metadata
route remains unchanged.

Every new Store now also writes
`canonical-property-store.analysis.json`. It records property-definition and
unique-name counts, unique values, instance/type counts, the top 20 most
frequent and largest source properties, plus SQLite page, data and index byte
usage. The Store implementation uses integer relationship keys, a
display-string dictionary, compact binary set hashes and removes the previous
redundant definition/value index. These changes affect only the internal
SQLite layout, not the retrieval response contract.
