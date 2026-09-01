# Revit Level & Spatial Contract

## Source metadata

Revit Publish Package v1 `source-metadata.json` has optional `levels` and per-element level fields:

```json
{
  "levels": [{
    "id": "revit-level-unique-id",
    "name": "Level 02",
    "elevation": 3.6,
    "sortOrder": 1,
    "source": "revit",
    "method": "explicit"
  }],
  "elements": [{
    "logicalElementId": "le-42",
    "levelId": "revit-level-unique-id",
    "levelAssignment": "explicit"
  }]
}
```

`id` is the Revit Level UniqueId. Elevation is converted from Revit internal feet to SI metres by the Copilot producer. `sortOrder` is deterministic (elevation, then name). Levels and associations originate from the Revit document; neither Hub nor Viewer infer them.

## Canonical Hub projection

The Hub writes the standard Viewer metadata version 2:

```json
{
  "levels": [{ "id": "revit-level-unique-id", "name": "Level 02", "elevation": 3.6, "source": "revit", "method": "explicit" }],
  "elements": {
    "xkt-object-id": {
      "parentId": "revit-level-unique-id",
      "spatial": { "levelId": "revit-level-unique-id", "levelAssignment": "explicit" }
    }
  }
}
```

This is the same `levels[]` contract that the Viewer receives from IFC. The Viewer does not branch on source type. Plan View uses the selected model's canonical level elevation and the existing view range.

## Unknown assignment

If Revit cannot provide an explicit `Element.LevelId`, the canonical element contains:

```json
{ "spatial": { "levelAssignment": "unknown" } }
```

It receives no invented `parentId` and is not placed under an arbitrary level.

## Spatial hierarchy and current scope

The currently supported hierarchy is `Project → Levels → Elements`; the element-to-level edge is `parentId`. Room/Space navigation, linked-model hierarchy, federated hierarchy, and automatic storey generation are intentionally out of scope.
