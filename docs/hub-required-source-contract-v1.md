# Hub Required Source Contract v1

**Status:** Authoritative Hub input contract  
**Date:** 2026-09-01  
**Applies to:** IFC, Revit, and future model-source adapters (OBJ, FBX, CAD)  

This document is the single official statement of what a source adapter must
provide for a model to support the current SymetrIQ Hub Viewer capabilities.
Producers may retain richer native data, but the Hub only exposes the
source-neutral canonical projection and Canonical Query API to the Viewer.

The Viewer must never branch on `sourceKind`.

## 1. Scope and terms

- **Source package**: geometry plus the producer-owned source metadata and
  identity map supplied to Hub.
- **Canonical metadata**: Hub-owned Viewer projection, currently `version: 2`.
- **Render object ID**: the exact local object ID emitted by XKT and selected
  by xeokit.
- **Logical element ID**: stable source element identity, independent of one
  or many render objects.
- **Unknown**: an explicit absence of trustworthy source information. Hub and
  Viewer must not infer or fabricate it.

Point clouds, panoramas, issues and scene settings are project artifacts, not
part of a BIM-model source package. Their requirements are documented below so
the Viewer capability audit remains complete.

## 2. Viewer capability audit and current status

Legend: **✅** available; **⚠** available with stated limitation; **❌** not
required from a model source or not currently supported.

| Capability | Required canonical/project data | Required fields | Required? | Current state | Missing-data behavior |
| --- | --- | --- | --- | --- | --- |
| XKT geometry rendering | Geometry package | `geometry.src`, XKT object IDs, model transform | Required | ✅ IFC/Revit | Model cannot load. |
| Materials, colours, transparency | Geometry package | glTF/XKT material and appearance data | Required when source has appearance | ✅ IFC/Revit | Default/unavailable appearance; geometry still loads where possible. |
| Scene background and UI appearance | Viewer configuration | no source-model field | Not required | ✅ | Uses Hub Viewer defaults. |
| Coordinate alignment / federated scene | Model package | `transform.position`, `transform.rotation`, source-local coordinates | Required when model is rebased | ✅ IFC/Revit | Model is placed at its source origin; alignment may be wrong. |
| Scene file toggle and package isolate | Project scene package | stable `model.id`, geometry package | Required | ✅ | File cannot be independently controlled. |
| Zoom all / 2 km scene guard | Renderer geometry bounds | XKT geometry bounds | Required | ✅ | Zoom cannot frame missing geometry. |
| Element selection and highlight | Geometry linkage | XKT `renderObjectId` | Required | ✅ IFC/Revit | Geometry can load, but element interaction is unavailable. |
| Hide, isolate, show all | Renderer identity | XKT `renderObjectId` | Required | ✅ IFC/Revit | Affected object cannot be controlled. |
| Section cut | Renderer geometry | pickable XKT triangles and world transform | Required | ✅ IFC/Revit | No surface can create a section plane. |
| Measurement | Renderer geometry | world-space XKT positions; metre coordinate convention | Required | ✅ IFC/Revit | Measurement is unavailable or inaccurate. |
| Compact selection heading | Bootstrap metadata | `elements[renderObjectId].name`, `type` | Required | ✅ IFC/Revit | Generic/empty heading. |
| Compact identity panel | Bootstrap metadata | `identity.logicalElementId`, source element ID, `category`, `family`, `type` | Required for rich BIM selection | ⚠ Revit compatibility alias; ⚠ IFC equivalent varies | Compact panel is incomplete. |
| Show all properties | Element Property Retrieval | render → logical mapping; property sets and values | Required for full LOI | ✅ Revit Query API; ✅ IFC canonical adapter | Panel remains empty or only bootstrap fields show. |
| Visible properties catalogue | Property definition catalogue | canonical `propertyDefinitionId`, display name, set/scope, value type, unit | Required for configuration | ✅ IFC/Revit | User cannot configure fields. |
| Visible property views | Property catalogue + persisted view | canonical `propertyDefinitionId` keys | Required for saved configurations | ✅ IFC/Revit; legacy name fallback | Missing fields are skipped. |
| Property search / property panel filtering | Definition catalogue and element retrieval | canonical property definitions and values | Required | ✅ IFC/Revit | No matching field/value can be found. |
| Property filter / isolate result | Canonical Query API | definition → distinct values/counts → matching render IDs | Required | ✅ IFC/Revit | Filter has no results; Viewer must not scan source metadata. |
| Category / Family / Type facets | Canonical Query API | `canonical:facet:category`, `family`, `type` | Required for those facets | ✅ Revit; ⚠ IFC only when canonical identity exposes it | Facet is omitted. |
| Property-based display colour | Canonical Query API + renderer IDs | definition, selected value IDs, matching render IDs | Required | ✅ IFC/Revit | No colour override is applied. |
| Saved display views | Persisted display view + Query API | canonical definition ID, canonical value IDs, colour/mode/opacity | Required when a view contains a colour override | ✅ IFC/Revit; legacy name/value fallback | View restores base display only. |
| Selected property → Filter | Selected property's canonical ID and value | `propertyDefinitionId`, canonical value ID, render mapping | Required | ✅ IFC/Revit | Action is disabled/no-op with a clear message. |
| Levels list and Plan View | Canonical metadata | `levels[]` `{id,name,elevation,source,method}` in metres | Required for plan | ✅ IFC; ⚠ Revit exporter integration must be delivered and manually verified | Plan controls show no levels. |
| Element → Level relation | Canonical metadata | `parentId` and `spatial.levelId`, or `spatial.levelAssignment:"unknown"` | Required for spatial hierarchy | ✅ IFC; ⚠ Revit exporter integration must be delivered and manually verified | Element is not put under a guessed level. Current V1 plan clipping does not yet filter by this relation. |
| Spatial hierarchy | Canonical metadata | `parentId` edges for trustworthy parents | Optional beyond Level → Element | ✅ IFC where IFC relations exist; ⚠ Revit Level → Element only | Tree/navigation cannot expose absent hierarchy. |
| Issue create, status, category, comments | Project issue record | screenshot, viewpoint, optional `{modelId,renderObjectId}` selection | Project-required, not source-required | ✅ | Issue remains project-only without selection context. |
| Issue reopen / viewpoint | Renderer + project issue record | camera/viewpoint, package visibility, renderer IDs when available | Optional selection linkage | ✅ | Viewpoint restores without reselecting an element. |
| Panorama markers and 360° viewer | Point-cloud/panorama project artifact | station ID, position, rotation, face URLs | Not model-source-required | ✅ structured E57 | No panoramas/markers. |
| LAS/LAZ and structured E57 point clouds | Point-cloud package | point-cloud source, LOD config, transform; E57 stations where present | Not BIM-source-required | ✅ | No point cloud. |
| Plan-view point-cloud handling | Point-cloud package + selected canonical level | point-cloud package and `levels[]` | Optional | ✅ where both exist | Point cloud remains hidden/unchanged in plan mode. |

## 3. Required canonical model package

Every model source adapter must provide the following semantic inputs to Hub.
Hub may convert, optimize, deduplicate and store them differently, but it must
be able to create this canonical output.

### 3.1 Geometry and render identity — required

```json
{
  "geometry": { "format": "glb", "path": "model.glb", "units": "metre" },
  "renderObjects": [{
    "renderObjectId": "stable-render-object-id",
    "logicalElementId": "stable-logical-element-id",
    "sourceElementId": "stable-source-element-id",
    "geometry": { "nodeName": "exact-glb-node-name" }
  }]
}
```

Rules:

1. `geometry.nodeName` must survive the geometry conversion chain, or the
   adapter must supply the final XKT ID mapping to Hub.
2. `renderObjectId` is immutable for the published revision.
3. One logical element may map to many render objects; every render object
   maps to exactly one logical element.
4. Hub maps final XKT object IDs to canonical metadata keys. The Viewer never
   resolves identity through node-name searches.

### 3.2 Bootstrap element projection — required

Canonical metadata emitted by Hub:

```json
{
  "version": 2,
  "elements": {
    "final-xkt-object-id": {
      "globalId": "source-neutral-display-identity",
      "type": "source-neutral-or-source-type-label",
      "name": "human-readable element name",
      "propertySetIds": [],
      "identity": {
        "logicalElementId": "stable-logical-element-id",
        "sourceElementId": "stable-source-element-id",
        "category": "Pipes",
        "family": "Pipe Types",
        "type": "DN100"
      },
      "propertyStore": { "renderObjectId": "stable-render-object-id" }
    }
  },
  "propertySets": {},
  "levels": []
}
```

`identity.sourceElementId` is the canonical source-neutral field. The current
Revit bootstrap also retains `revitUniqueId` as a compatibility alias; new
source adapters must not require the Viewer to understand it.

Required fields are `globalId`, `type`, `name`, `propertySetIds` (empty is
valid), `identity.logicalElementId`, `identity.sourceElementId`,
`identity.category`, `identity.family`, `identity.type`, and
`propertyStore.renderObjectId`. A source without family/type must emit an
empty string, not a fabricated classification.

### 3.3 Complete properties — required for LOI features

The source package must preserve the complete accessible property graph,
separate from the bootstrap projection:

```json
{
  "propertyDefinitions": [{
    "id": "source-stable-definition-id",
    "name": "Diameter",
    "scope": ["instance", "type"],
    "valueType": "number",
    "unit": "metre",
    "provenance": "source-native"
  }],
  "propertySets": [{
    "id": "source-stable-set-id",
    "name": "Dimensions",
    "scope": "instance",
    "values": [{ "propertyDefinitionId": "source-stable-definition-id", "rawValue": 0.1, "displayValue": "100 mm" }]
  }],
  "logicalElements": [{
    "logicalElementId": "stable-logical-element-id",
    "propertySetIds": ["source-stable-set-id"],
    "typeId": "optional-source-type-id"
  }]
}
```

The producer owns source IDs and native values. Hub owns canonical definition
IDs, property deduplication, Property Store, property catalogue, distinct
value counts and render-object match queries. `displayValue` is optional but
strongly recommended for source-formatted units. Missing/unreadable values may
be omitted; they must not be replaced by guesses.

### 3.4 Levels and spatial relations — required for Plan View

```json
{
  "levels": [{
    "id": "stable-source-level-id",
    "name": "Level 02",
    "elevation": 3.6,
    "sortOrder": 1,
    "source": "source-adapter-name",
    "method": "explicit"
  }],
  "logicalElements": [{
    "logicalElementId": "stable-logical-element-id",
    "levelId": "stable-source-level-id",
    "levelAssignment": "explicit"
  }]
}
```

Rules:

- `elevation` is SI metres in model-local vertical coordinates.
- `id` is stable within the source document/revision; `sortOrder` is
  deterministic.
- For a trustworthy Level link, Hub writes both `element.parentId` and
  `element.spatial = { levelId, levelAssignment: "explicit" }`.
- If no trustworthy relation exists, emit
  `levelAssignment: "unknown"` and no `levelId`. Hub does not infer a level.
- Additional trustworthy spatial parents may be emitted as `parentId` edges.
  Room/Space, linked-model and federated hierarchy are not required in v1.

### 3.5 Appearance and coordinate requirements — conditional

- Preserve source material/colour/transparency when the source exposes them.
- Geometry must be in metres or declare an exact conversion before Hub
  conversion.
- A source whose coordinates require rebasing must provide the precise model
  transform/origin relation. Hub must not use visual heuristics to align it.

## 4. Gap matrix

| Contract area | IFC adapter | Revit adapter / Hub path | Status | Required next action |
| --- | --- | --- | --- | --- |
| Geometry and final render identity | Present | Present via GLB + object map | ✅ | Maintain identity validation. |
| Materials/appearance | Present | Present in CustomExporter path | ✅ | Regression-test on publish. |
| Bootstrap identity | Present | Revit currently exposes a `revitUniqueId` compatibility alias in the Viewer projection | ⚠ | Emit source-neutral `identity.sourceElementId` alongside or instead of the alias. |
| Full source properties | Present as IFC canonical sets | Present as Revit source metadata + Property Store | ✅ | No Viewer expansion of bootstrap. |
| Definition/value/match query | IFC metadata adapter | SQLite Property Store adapter | ✅ | Maintain one API contract. |
| Category/family/type facets | Available where exported | Available Store facets | ⚠ | IFC adapters should expose canonical identity facets consistently. |
| Levels | Explicit storeys | Exporter implementation prepared; delivery/manual validation pending | ⚠ | Publish a Revit model and verify elevations against Revit. |
| Level → element mapping | IFC spatial relations | Exporter implementation prepared; delivery/manual validation pending | ⚠ | Test pipes, ducts, fittings, equipment and unlevelled elements. |
| Spatial hierarchy beyond levels | IFC partial hierarchy | Not required beyond Level → Element | ⚠ | Keep out of v1 scope. |
| Point clouds/panoramas | Project artifacts | Not applicable | ✅ | No model-adapter work. |
| Issues/viewpoints | Project artifacts | Not applicable | ✅ | No model-adapter work. |

## 5. Producer conformance rules

An adapter conforms to **Hub Required Source Contract v1** when:

1. every rendered model object has an explicit render → logical → source
   identity path;
2. it preserves complete accessible properties outside bootstrap metadata;
3. it emits trustworthy native values and units/provenance where available;
4. it supplies canonical level input in metres and explicit unknowns instead
   of inferred links;
5. it preserves geometry appearance and declared coordinate semantics; and
6. Hub can produce canonical metadata v2 plus Canonical Query API results
   without Viewer source-specific code.

## 6. Explicit non-requirements in v1

- IFC GlobalIds, `Ifc*` entity names, WebIFC type codes and IFC Pset IDs;
- Revit UniqueIds, BuiltInParameter names or Revit internal-unit values in the
  Viewer contract;
- Room/Space navigation, auto-generated storeys, linked-model hierarchy,
  federated spatial merge;
- point cloud, panorama, issue or saved-view data in a BIM model source
  package.

Any later source capability must extend this document with a versioned,
source-neutral field. It must not introduce Viewer branches by source type.
