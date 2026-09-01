# IFC–Revit Viewer Functional Parity Audit

Date: 2026-09-01

## Scope

This audit traces every current Viewer capability that reads model metadata or
identity. Geometry loading, point clouds, panoramas, measurements and section
cuts are renderer features and are already source-neutral once an XKT model is
loaded. The items below are the metadata-dependent parity surface.

| Viewer capability | Current data source | IFC status | Revit status | Parity action |
| --- | --- | --- | --- | --- |
| Geometry, selection highlight, hide/isolate/section | XKT renderer object ID | Supported | Supported | No metadata change required |
| Compact identity panel | `metadata.elements` and property sets | Full canonical metadata | Lightweight identity projection | Keep bootstrap identity; property values use Query API |
| Show all properties | Bootstrap property sets | Supported | Element Property Retrieval API | Keep API; make configured panel use same result |
| Visible properties configuration | Bootstrap property sets | Supported | Property Definition Catalog | Completed in 003C; Viewer receives one canonical catalog contract |
| Property filters | Bootstrap property sets and element scan | Supported | Incomplete: values are not in bootstrap | Move definitions, value facets and matched object IDs to Canonical Query API |
| Property-based display colour | Bootstrap property sets and element scan | Supported | Incomplete for same reason | Move to Canonical Query API |
| Saved property views | Property-name keys | Supported | Keys now need canonical definition IDs | Keep persistence model; normalize all UI keys to Catalog definition IDs |
| Element action filter button | Selected bootstrap/retrieved property value | Supported | Must route through Query API | Use canonical definition ID plus selected value |
| Plan levels / plan view | `metadata.levels` from IFC storeys | Supported | Not available: Revit source has no trusted levels | Separate input-contract gap; do not fabricate levels |
| Spatial hierarchy | IFC hierarchy in canonical metadata | Supported where present | Not exported as a Revit hierarchy | Separate input-contract gap |
| Category/family/type filtering | Bootstrap identity/property values | Supported | Category/family/type exist in Store facets | Include them in canonical definition/value query layer |
| Issue selection and screenshots | renderer ID + lightweight selection fields | Supported | Supported | No change |
| Measurement, Zoom all, scene visibility, point clouds, panoramas | Renderer/project packages | Supported | Supported | No change |

## Root cause of the remaining property gap

The Viewer currently derives filter values and matching object IDs by scanning
`metadata.propertySets` in the bootstrap document. Revit bootstrap metadata is
intentionally lightweight, so that scan has no complete property values to
work with. This is a Viewer data-source issue, not an export or Property Store
data-loss issue.

## Canonical Query API target

The Viewer must use one source-neutral query contract for both IFC and Revit:

1. `property-definitions` — available fields (already implemented).
2. `property-values` — distinct values and matching object count for one
   definition.
3. `property-matches` — renderer object IDs matching one definition and one or
   more selected values.

The Hub implements these with a Revit Property Store adapter or an IFC
canonical-metadata adapter. The Viewer does not inspect source kind, raw Revit
parameters, IFC property-set internals or GLB node names.

## Explicitly deferred source-contract gaps

Revit plan levels and spatial hierarchy cannot be made equivalent merely by
querying the existing Store because the current Revit Source Metadata contract
does not provide reliable level elevations or a complete spatial hierarchy.
Those need a later Copilot export-contract sprint. All property-dependent
Viewer features can reach parity with the Query API work in this sprint.
