# Hub Required Source Contract v1.1

**Status:** Authoritative current-source contract; supersedes v1 for new
compliance audits  
**Date:** 2026-09-01  
**Applies to:** IFC, Revit and future source adapters.  
**Scope:** Current Hub + Viewer behaviour only. This document does not create
new Viewer requirements.

Hub is the sole canonical-adaptation boundary. A producer supplies native
geometry, identity and source metadata; Hub creates canonical metadata,
derivatives and query results; the Viewer consumes only canonical data and
never branches by source type.

## 1. Requirement classes

| Class | Meaning for adapter compliance |
| --- | --- |
| **Current capability requirement** | Required because a current Hub/Viewer capability actually consumes it, or because Hub demonstrably needs it to build that capability's canonical representation. |
| **Optional semantic enrichment** | Useful trustworthy information which is preserved when available, but no active Viewer capability requires it. Its absence is not a current compliance failure. |
| **Future capability requirement** | Not part of v1.1 compliance. It may become required only in a versioned future contract. |

`Unknown` always means “not reliably supplied by the producer”. Hub and
Viewer must not infer or fabricate a value.

## 2. Canonical terminology

- **renderObjectId** – exact final XKT object ID selected by xeokit.
- **logicalElementId** – stable semantic element identity, which can own one
  or more render objects.
- **sourceElementId** – stable producer-native identity (for example IFC
  GlobalId or a Revit-native ID), held behind the source-neutral name.
- **Bootstrap metadata** – small `version: 2` projection loaded with a scene.
- **Property Store / Canonical Query API** – Hub-owned complete-property
  representation and property definition/value/match queries.

## 3. Corrected Plan View and Level Catalog contract

### 3.1 What the current implementation actually does

For IFC, `extractMetadata` finds `IfcBuildingStorey` objects, maps
`GlobalId`, `Name` and `Elevation * unitScale` into canonical levels, then
sorts them by elevation. The Viewer loads `metadata.levels` from the selected
reference model. When a user selects one, it passes only that level's
elevation and the configured range to `ViewerService.enterPlanView`.

The renderer creates a **global horizontal section plane** at
`level.elevation + range.cut`. It uses no element metadata to select which
objects are visible. In particular it does not read `element.parentId`,
`element.spatial.levelId`, IFC containment, or any element → level mapping.
`Lower` and `Upper` are retained UI/range settings; the current service's
active section plane uses `Cut`.

Therefore a correct `levels[]` list is sufficient for the current Plan View.
It is not necessary for any rendered object to be assigned to a level.

### 3.2 Current capability requirement: Level Catalog / Plan View

```json
{
  "levels": [
    { "id": "stable-source-level-id", "name": "Level 02", "elevation": 3.6 }
  ]
}
```

| Field | Requirement | Current use |
| --- | --- | --- |
| `id` | Required, stable within the published revision | Selection and reference of a level in the Plan View UI. |
| `name` | Required, human-readable | Level-list label. |
| `elevation` | Required, finite SI metres in model-local vertical coordinates | Global Plan View section-plane position and camera target. |
| deterministic list/order | Required outcome | Stable UI ordering; Hub may sort by elevation. |
| `source`, `method`, `sortOrder` | Optional semantic enrichment | Preserved provenance/order information; current Plan View does not require it. |

If `levels[]` is empty or invalid, geometry still loads but Plan View has no
selectable level. This is the complete current Plan View source requirement.

### 3.3 Optional semantic enrichment: Element Spatial Assignment

```text
logicalElementId → levelId / parentId
```

Trustworthy `levelId`, `parentId`, `spatial.levelId` and spatial-containment
edges are **not** Plan View requirements. They are currently optional
semantic enrichment. Hub preserves IFC relationships and can project Revit
ones when supplied, but no active Viewer path consumes them for Plan View,
filtering or visibility.

They become a future capability requirement only for level-based element
grouping/filtering, spatial trees/navigation, Room/Space navigation or
federated hierarchy. Unknown must remain explicit rather than guessed.

## 4. Current Viewer capability audit

| Capability | Exact current canonical/project input | Class | Behaviour if absent |
| --- | --- | --- | --- |
| Geometry rendering, scene toggle, Zoom All | XKT geometry, model ID/package and geometry bounds | Current | Model/package cannot load or be independently controlled. |
| Geometry appearance | source material/colour/transparency when available | Conditional current | Geometry may use available/default appearance. |
| Coordinates / federation | explicit model transform/origin when the model is rebased or federated | Conditional current | Model remains source-local; alignment can be wrong. |
| Selection, hide, isolate, section | final `renderObjectId` linked to XKT geometry | Current | Object cannot be selected or controlled. |
| Measurement | metre world-space geometry positions | Current | Measurements are unavailable or inaccurate. |
| Compact Selection panel | bootstrap `name`, `type`, identity `logicalElementId`, `sourceElementId`, `category`, `family`, `type` | Current for rich BIM selection | Empty/unavailable fields are omitted; geometry remains usable. |
| Show all properties | render → logical mapping plus canonical property sets/values | Current for LOI | Full-properties panel is empty. |
| Visible properties / configured fields | canonical property definition ID, display name, scope and value type | Current | User cannot configure those fields. |
| Property search, filter, isolate and selected-property Filter action | Canonical Query API: definitions, distinct values/counts, matches → render IDs | Current | Property result cannot be queried; no bootstrap scan fallback is permitted. |
| Property display colours and saved property views | canonical definition ID, canonical value IDs and matches → render IDs | Current | Colour override/view part is skipped. Legacy name-keyed saved views use compatibility fallback. |
| Category / Family / Type facets | canonical identity/facet values represented by the same Query API | Current where a source exposes the classification | Empty/unavailable source semantics produce an empty facet, not fabricated values. |
| Plan View level picker and clipping | reference model `levels[]` `id`, `name`, `elevation` | Current | No selectable Plan View levels. |
| Element spatial hierarchy / level-element grouping | `parentId`, `spatial.levelId`, spatial edges | Optional semantic enrichment | No current Viewer regression: this is not consumed today. |
| Issues and viewpoints | project issue record, camera/viewpoint, optional `{modelId,renderObjectId}` | Project-owned, not source-required | Issue remains unlinked to an element. |
| LAS/LAZ, E57 and panoramas | separate point-cloud/station artifacts | Project-owned, not BIM-source-required | No point cloud/panorama. |
| Background/UI, property views and display views | Viewer/project configuration | Project-owned | Hub defaults/persisted project state apply. |

## 5. Source-neutral current input contract

### 5.1 Geometry and identity

Every rendered object requires an explicit, conversion-safe identity path:

```json
{
  "geometry": { "format": "glb", "path": "model.glb", "units": "metre" },
  "renderObjects": [{
    "renderObjectId": "producer-render-id",
    "logicalElementId": "stable-logical-id",
    "sourceElementId": "stable-native-id"
  }]
}
```

One logical element may own multiple render objects; each render object maps
to exactly one logical element. Hub must retain the mapping through optimizer,
`convert2xkt` and canonical projection to the final XKT object ID. Node-name
searching is not an identity contract.

For each logical element the producer provides a human-readable `name` and
the source's available `category`, `family` and `type`. Empty strings are
valid when a source genuinely has no equivalent semantic; the Viewer must not
need Revit-, IFC- or source-specific fields.

### 5.2 Complete properties

For full LOI functionality, preserve complete accessible instance and type
properties separately from bootstrap metadata. A property input has a stable
source definition identity, display name, scope, native/raw value, and an
element or type association. Definition `valueType`, unit, provenance and a
source-formatted `displayValue` are optional enrichment but strongly
recommended. Hub owns canonical IDs, deduplication, Property Store and all
Canonical Query API responses.

### 5.3 Bootstrap projection

Hub emits `version: 2` metadata with `elements`, `propertySets` and `levels`
always present. Bootstrap must contain only scene/selection identity and
object mapping; it is not a complete property payload. The current Viewer
uses on-demand retrieval for full values.

### 5.4 Levels

The producer must supply the Level Catalog in §3.2 when Plan View is expected.
It must not invent element-level assignment. Spatial assignment is handled
under §3.3 and is optional in v1.1.

### 5.5 Conditional appearance and coordinates

Preserve native materials, colours and transparency when exposed by the
source. Geometry must be metre-based or carry an exact conversion. When
rebasing/federation is needed, supply exact transform/origin data; Hub must
not align models through visual heuristics.

## 6. Corrected gap matrix

| Capability / contract area | IFC adapter | Revit adapter / current Hub path | Current compliance status |
| --- | --- | --- | --- |
| Geometry and final render identity | Present | Present via GLB and object map | ✅ |
| Appearance | Present | Present through CustomExporter materials | ✅ |
| Bootstrap identity | Present, semantics vary by IFC class | Present, including source-neutral normalization/compatibility alias | ✅ |
| Complete properties and on-demand retrieval | Canonical IFC adapter | Source metadata → Property Store | ✅ |
| Canonical Query API, filters, colours, saved views | Same Viewer contract | Same Viewer contract | ✅ |
| Category / Family / Type facets | Present where IFC exposes semantics | Present where Revit exposes semantics | ✅; empty values are valid where not native |
| **Level Catalog** (`id/name/elevation`) | Explicit `IfcBuildingStorey` extraction | Hub projection is implemented; producer delivery requires release/manual elevation validation | ⚠ delivery verification |
| **Plan View** | Uses catalog only | Uses same source-neutral catalog only | ✅ once valid levels are delivered |
| **Element Spatial Assignment** | IFC containment/parents preserved where present | Can be projected when producer supplies it | Optional; not a current parity gap |
| Spatial hierarchy/navigation | Partial IFC semantic enrichment | Partial/optional | Future capability, not a current compliance gap |
| Coordinates / federated placement | Supported when explicit origin/transform exists | Conditional on explicit producer transform | ⚠ only for rebased/federated sources |
| Issues, point clouds, panoramas | Project artifacts | Not applicable to BIM adapter | Not source-contract scope |

## 7. Copilot Required Source Inputs

This is the complete handoff checklist for a Revit Source Adapter compliance
audit. “Required” refers to present Hub capabilities, not desirable future
semantics.

| Source input | Required for | Required / optional | Expected form | Notes |
| --- | --- | --- | --- | --- |
| GLB geometry | Rendering, measurement, conversion | Required | metre-based GLB | Must preserve valid geometry through optimization/XKT conversion. |
| Render-object mapping | Selection, filters, property retrieval | Required | explicit render → logical mapping, conversion-safe | No `node.name` lookup as primary identity. |
| `logicalElementId` | BIM identity and property ownership | Required | stable logical ID | One logical element may have many render objects. |
| `sourceElementId` | Source identity | Required | stable Revit-native identifier | Exposed source-neutrally by Hub; Revit aliases do not become Viewer requirements. |
| Name | Selection heading | Required | human-readable string | Empty only if source truly has none. |
| Category / Family / Type | Compact panel and facets | Required where native; empty allowed when unavailable | strings | Do not fabricate IFC/Revit equivalents. |
| Property definitions | Full LOI, catalogue, queries | Required | source-stable definition identity, name, scope | Hub canonicalizes/deduplicates. |
| Instance property values | Full LOI/query | Required | native/raw value + element association | Omit unreadable values; do not guess. |
| Type property values/type association | Full LOI/query | Required when source has type semantics | native/raw values + type association | Hub may deduplicate by type. |
| Formatted value, type, unit, provenance | Readability and future semantic fidelity | Optional enrichment | display value / declared type / unit / provenance | Strongly recommended; not required by every current Viewer path. |
| `levels[]` | Plan View | Required when Plan View is expected | stable `id`, `name`, `elevation` in SI metres | Deterministic catalog; no element assignment required. |
| Element → level / parent assignment | Spatial hierarchy | Optional semantic enrichment | trustworthy `levelId`/`parentId`, or explicit unknown | Not used by current Plan View. |
| Appearance | Visual fidelity | Conditional | source-native materials/colours/transparency | Required only where the source exposes and publishes appearance. |
| Model transform/origin | Alignment/federation | Conditional | explicit transform/origin relation | Required only for rebased/federated placement. |

## 8. Implementation ownership

| Concern | Copilot / producer | Hub | Viewer |
| --- | :---: | :---: | :---: |
| Source geometry extraction | ✔ |  |  |
| Source identity and render-object map | ✔ | validates/preserves |  |
| Source property and level-catalog extraction | ✔ |  |  |
| Canonical adaptation and bootstrap projection |  | ✔ |  |
| Property Store, property catalogue and Canonical Query API |  | ✔ | consumes | 
| Geometry optimization and XKT derivative |  | ✔ | consumes XKT |
| Project records, issues, panoramas and point clouds |  | ✔ | consumes/renders |
| Plan View level selection and global section rendering |  | supplies catalog | ✔ |
| Element spatial hierarchy | supplies if trustworthy | preserves/projects | future consumer |

## 9. Non-requirements and future semantics

The following do not affect v1.1 compliance: IFC entity names/Pset IDs,
Revit-specific API names/internal units, element-level assignment, spatial
trees, Room/Space navigation, linked/federated hierarchy merge, automatic
storey inference, or source-specific Viewer branches.

Any capability that begins consuming these fields must first add a versioned
requirement to this contract. Until then the canonical Level Catalog and
Element Spatial Assignment remain deliberately independent.

## 10. Implementation evidence

- Backend IFC extraction: `src/metadata.ts` (`IfcBuildingStorey` discovery,
  canonical `levels` projection, and separate containment/parent handling).
- Viewer data flow: `src/components/Viewer.tsx` (`planLevels`,
  `openPlanLevel`, `reloadPlanView`).
- Renderer behaviour: `src/services/ViewerService.ts`
  (`enterPlanView`), which creates the global Cut plane from elevation and
  does not read element spatial metadata.
- Canonical property operations: `src/publish/canonicalPropertyStore.ts` and
  Publish/property-query routes; Viewer filter integrations consume the
  Canonical Query API.

