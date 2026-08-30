# Hub canonical IFC metadata contract

This document records the canonical metadata contract currently emitted by the
working IFC → Hub → Viewer pipeline. It is a baseline for other producers,
including the SymetrIQ Copilot Revit exporter.

## Production source and pipeline point

The reference was read from the published `PT5_mep_shared_coord.ifc` package
in Alpha on 2026-08-30. Its metadata has exactly these top-level fields:

```json
{
  "version": 2,
  "elements": {},
  "propertySets": {},
  "levels": []
}
```

There are no other top-level fields in the production IFC metadata contract.

In the backend, canonical IFC metadata is created in `extractMetadata()` in
`src/metadata.ts`. Before it is written to `<modelId>.metadata.json`,
`mapMetadataToGlbNodes()` re-keys `elements` from IFC GlobalId to the GLB node
name. This is essential: the final keys are the local XKT object IDs consumed
by the Viewer.

```text
IFC GlobalId
  → IfcConvert GLB node: product-<UUID>-body
  → convert2xkt local XKT object ID
  → metadata.elements["product-<UUID>-body"]
```

## Canonical schema

```ts
interface ModelProperty {
  name: string;
  value: unknown;
  type?: string | number;
  description?: string;
}

interface ModelPropertySet {
  id: string;
  name: string;
  type: string;
  properties: ModelProperty[];
}

interface ModelElement {
  globalId: string;
  type: string;
  name: string;
  parentId?: string;
  propertySetIds: string[];
}

interface ModelLevel {
  id: string;
  name: string;
  elevation: number; // metres, local model coordinates
  source: "ifc" | string;
  method: "explicit" | "inferred" | "manual" | string;
}

interface ModelMetadata {
  version: number; // current value: 2
  elements: Record<string, ModelElement>;
  propertySets: Record<string, ModelPropertySet>;
  levels: ModelLevel[];
}
```

`elements`, `propertySets` and `levels` are required in a canonical Hub file.
The Viewer resilience layer accepts missing values from external inputs, but a
producer must emit the canonical shape above.

## Representative production-derived JSON

This is a deliberately reduced, readable subset. It retains real production
IFC types, object-ID form, level IDs and property value shapes; each element's
full production metadata has further property sets.

```json
{
  "version": 2,
  "elements": {
    "product-7beab803-baf3-4bdf-a00e-b9742b06582a-body": {
      "globalId": "1xwhW3klDBtw0EkNGh1bWg",
      "type": "IfcFlowSegment",
      "name": "Pipe Types:VA:10853207",
      "parentId": "269zrty8D9z9ygqXZ1qtYA",
      "propertySetIds": ["pipe-mechanical", "pipe-dimensions", "pipe-other", "pipe-quantity"]
    },
    "product-18defa4b-91fe-4ced-bc82-b26dd060fc00-body": {
      "globalId": "0OtlfBaVvCxRo2ictGOFm0",
      "type": "IfcFlowFitting",
      "name": "Plumbing-Bend-Valsir-PP-Negative-02:Standard:10921372",
      "parentId": "269zrty8D9z9ygqXZ1qtYA",
      "propertySetIds": ["pipe-fitting-mechanical", "pipe-fitting-dimensions", "pipe-fitting-other"]
    },
    "product-a30d096f-cc40-4bf6-9171-d59bb2ee8ed3-body": {
      "globalId": "2Z3Gblp41Bzf5nrPkoxexJ",
      "type": "IfcFlowSegment",
      "name": "Round Duct:BM_GE_LT_Kor legcsatorna:10865918",
      "parentId": "269zrty8D9z9ygqXZ1qtYA",
      "propertySetIds": ["duct-mechanical", "duct-dimensions", "duct-other"]
    },
    "product-a30d096f-cc40-4bf6-9171-d59bb2ee8fe0-body": {
      "globalId": "2Z3Gblp41Bzf5nrPkoxe$W",
      "type": "IfcFlowFitting",
      "name": "CADvent BKU:BKU:10865928",
      "parentId": "269zrty8D9z9ygqXZ1qtYA",
      "propertySetIds": ["duct-fitting-mechanical", "duct-fitting-dimensions", "duct-fitting-other"]
    },
    "product-6e68311e-c5ca-47bc-888c-cfe3c7a9ec4a-body": {
      "globalId": "1kQ34UnSf7l8YCp_F7gUnA",
      "type": "IfcBuildingElementProxy",
      "name": "Defro REKU-DRX-1200-C:Defro REKU-DRX-1200-C:11014563",
      "parentId": "269zrty8D9z9ygqXZ1qtYA",
      "propertySetIds": ["equipment-mechanical", "equipment-dimensions", "equipment-other"]
    },
    "product-ec454e35-703c-4883-a538-f76b2484ee43-body": {
      "globalId": "3iHKurS3n8WwKuzsiaXEv3",
      "type": "IfcBuildingElementProxy",
      "name": "TB_Hanger_Round_Warp:TB_Hanger_Round_Warp:11939219",
      "parentId": "269zrty8D9z9ygqXZ1qtYA",
      "propertySetIds": ["generic-dimensions", "generic-other", "generic-quantity"]
    }
  },
  "propertySets": {
    "pipe-mechanical": {
      "id": "pipe-mechanical", "name": "Mechanical", "type": "IfcPropertySet",
      "properties": [
        {"name": "Diameter", "value": 65, "type": 4},
        {"name": "Material", "value": "BM_PIP_GENERAL_VA_MAT", "type": 1},
        {"name": "System Abbreviation", "value": "FIW", "type": 1},
        {"name": "System Classification", "value": "Fire Protection Wet", "type": 1},
        {"name": "System Name", "value": "FIW 1", "type": 1},
        {"name": "System Type", "value": "BM_PIP_FIW_SU_0_Nedves tüzivíz hálózat", "type": 1}
      ]
    },
    "pipe-dimensions": {
      "id": "pipe-dimensions", "name": "Dimensions", "type": "IfcPropertySet",
      "properties": [{"name": "Length", "value": 24092.82962007157, "type": 4}, {"name": "Size", "value": "65", "type": 1}]
    },
    "pipe-other": {
      "id": "pipe-other", "name": "Other", "type": "IfcPropertySet",
      "properties": [{"name": "Category", "value": "Pipes", "type": 1}, {"name": "Family", "value": "Pipe Types", "type": 1}, {"name": "Type", "value": "VA", "type": 1}]
    },
    "pipe-quantity": {
      "id": "pipe-quantity", "name": "Pset_QuantityTakeOff", "type": "IfcPropertySet",
      "properties": [{"name": "Reference", "value": "VA", "type": 1}]
    },
    "pipe-fitting-mechanical": {
      "id": "pipe-fitting-mechanical", "name": "Mechanical", "type": "IfcPropertySet",
      "properties": [{"name": "System Abbreviation", "value": "CSW", "type": 1}, {"name": "System Name", "value": "CSW 1", "type": 1}]
    },
    "pipe-fitting-dimensions": {
      "id": "pipe-fitting-dimensions", "name": "Dimensions", "type": "IfcPropertySet",
      "properties": [{"name": "Angle", "value": 45, "type": 4}, {"name": "Size", "value": "50-50", "type": 1}, {"name": "Volume", "value": 0.00011846455221087671, "type": 4}]
    },
    "pipe-fitting-other": {
      "id": "pipe-fitting-other", "name": "Other", "type": "IfcPropertySet",
      "properties": [{"name": "Category", "value": "Pipe Fittings", "type": 1}, {"name": "Family", "value": "Plumbing-Bend-Valsir-PP-Negative-02", "type": 1}, {"name": "Type", "value": "Standard", "type": 1}]
    },
    "duct-mechanical": {
      "id": "duct-mechanical", "name": "Mechanical", "type": "IfcPropertySet",
      "properties": [{"name": "System Abbreviation", "value": "SUA", "type": 1}, {"name": "System Classification", "value": "Supply Air", "type": 1}, {"name": "System Name", "value": "SUA 1", "type": 1}]
    },
    "duct-dimensions": {
      "id": "duct-dimensions", "name": "Dimensions", "type": "IfcPropertySet",
      "properties": [{"name": "Diameter", "value": 315, "type": 4}, {"name": "Length", "value": 531.6349265504799, "type": 4}]
    },
    "duct-other": {
      "id": "duct-other", "name": "Other", "type": "IfcPropertySet",
      "properties": [{"name": "Category", "value": "Ducts", "type": 1}, {"name": "Family", "value": "Round Duct", "type": 1}, {"name": "Type", "value": "BM_GE_LT_Kor legcsatorna", "type": 1}]
    },
    "duct-fitting-mechanical": {
      "id": "duct-fitting-mechanical", "name": "Mechanical", "type": "IfcPropertySet",
      "properties": [{"name": "System Abbreviation", "value": "REA", "type": 1}, {"name": "System Classification", "value": "Return Air", "type": 1}, {"name": "System Name", "value": "REA 2", "type": 1}]
    },
    "duct-fitting-dimensions": {
      "id": "duct-fitting-dimensions", "name": "Dimensions", "type": "IfcPropertySet",
      "properties": [{"name": "Angle", "value": 90, "type": 4}, {"name": "D", "value": 315, "type": 4}, {"name": "Size", "value": "315-315", "type": 1}, {"name": "Volume", "value": 0.023135495924393252, "type": 4}]
    },
    "duct-fitting-other": {
      "id": "duct-fitting-other", "name": "Other", "type": "IfcPropertySet",
      "properties": [{"name": "Category", "value": "Duct Fittings", "type": 1}, {"name": "Family", "value": "CADvent BKU", "type": 1}, {"name": "Type", "value": "BKU", "type": 1}]
    },
    "equipment-mechanical": {
      "id": "equipment-mechanical", "name": "Mechanical", "type": "IfcPropertySet",
      "properties": [{"name": "System Classification", "value": "Return Air,Supply Air,Exhaust Air,Sanitary", "type": 1}, {"name": "System Name", "value": "REA 2,FRA 2,SUA 1,EXA 1,DSW 20", "type": 1}]
    },
    "equipment-dimensions": {
      "id": "equipment-dimensions", "name": "Dimensions", "type": "IfcPropertySet",
      "properties": [{"name": "Area", "value": 3.6656054217714265, "type": 4}, {"name": "Volume", "value": 1.1276673981574565, "type": 4}]
    },
    "equipment-other": {
      "id": "equipment-other", "name": "Other", "type": "IfcPropertySet",
      "properties": [{"name": "Category", "value": "Mechanical Equipment", "type": 1}, {"name": "Family", "value": "Defro REKU-DRX-1200-C", "type": 1}, {"name": "Type", "value": "Defro REKU-DRX-1200-C", "type": 1}]
    },
    "generic-dimensions": {
      "id": "generic-dimensions", "name": "Dimensions", "type": "IfcPropertySet",
      "properties": [{"name": "AnchorElevation", "value": 1600, "type": 4}, {"name": "Diameter", "value": 73.025, "type": 4}, {"name": "Volume", "value": 0.00011071721522658295, "type": 4}]
    },
    "generic-other": {
      "id": "generic-other", "name": "Other", "type": "IfcPropertySet",
      "properties": [{"name": "Category", "value": "Generic Models", "type": 1}, {"name": "Family", "value": "TB_Hanger_Round_Warp", "type": 1}, {"name": "Type", "value": "TB_Hanger_Round_Warp", "type": 1}]
    },
    "generic-quantity": {
      "id": "generic-quantity", "name": "Pset_QuantityTakeOff", "type": "IfcPropertySet",
      "properties": [{"name": "Reference", "value": "TB_Hanger_Round_Warp", "type": 1}]
    }
  },
  "levels": [
    {"id": "269zrty8D9z9ygqXZ1qtYA", "name": "Földszint", "elevation": 0, "source": "ifc", "method": "explicit"},
    {"id": "22g4q9rMH0w97FaahqzG3H", "name": "Tető", "elevation": 13.53, "source": "ifc", "method": "explicit"}
  ]
}
```

## Property contract and Viewer consumption

The Viewer resolves a selected renderer object as:

```text
selected XKT local object ID
  → metadata.elements[rendererObjectId]
  → element.propertySetIds[]
  → metadata.propertySets[propertySetId].properties[]
```

Required for selection and properties:

- `elements` must be a record keyed by the XKT local object ID.
- An element must have `propertySetIds` (an empty array is valid).
- Each referenced property set must have `id`, `name`, `type`, and `properties`.
- Each property must have `name` and `value`. `type` and `description` are
  preserved by the Viewer but are not required to render the property panel.

The Viewer uses all property sets to build the property-filter catalogue, and
uses `name`/`value` to display and filter values. `element.name` appears as the
selection heading. `globalId`, `type` and `name` are also captured in issue
selections. `description` is not currently displayed by the Viewer.

`value` is emitted as the native IFC value (string, number or boolean in the
production reference). The numeric `type` values in IFC metadata are WebIFC
runtime type codes; the Viewer does not interpret them. There is currently no
canonical property-unit field. In particular, IFC-derived dimension property
values retain the source/exporter units; consumers must not infer a universal
unit from `type: 4`.

## Levels contract

```text
IfcBuildingStorey.GlobalId + Elevation + Name
  → levels[]: { id, name, elevation, source: "ifc", method: "explicit" }

IfcRelContainedInSpatialStructure / IfcRelAggregates
  → element.parentId = related spatial parent GlobalId
```

Storey elevations are converted to metres using the IFC length-unit scale and
sorted ascending. In the reference package, the Pipe, Pipe Fitting, Duct,
Duct Fitting, equipment and generic elements all have `parentId` equal to the
`Földszint` level ID.

The current Viewer Plan View uses `levels[]` from the model selected as the
project's plan reference. It adds that model's vertical render offset, creates
an orthographic camera and applies a level-relative horizontal cut plane.
It **does not currently filter objects by `parentId`**. `parentId` is still
canonical and should be emitted where a source has a reliable spatial parent.

## Copilot implementation guidance

Required for Revit parity:

1. Emit `version: 2`, `elements: {}`, `propertySets: {}`, `levels: []`.
2. Key `elements` by the exact XKT local object ID. For the current Revit GLB
   exporter, this is the Revit `UniqueId` because it is the GLB node name and
   `convert2xkt` preserves it.
3. Emit one or more property sets per element and include at least the Revit
   identity/category/family/type values already defined in the Revit normalizer.
4. Preserve native JSON values for numbers and booleans. Do not invent units.
5. Emit `levels: []` until Revit has reliable level ID, name and metre
   elevation data. Do not fabricate `parentId`.

IFC-specific data that Revit does **not** need to reproduce:

- IFC compressed `GlobalId` values and `Ifc*` entity type names;
- IFC property-set GlobalIds and WebIFC numeric type codes;
- IFC-only property sets such as `Pset_QuantityTakeOff` and
  `Pset_DistributionFlowElementCommon`;
- `source: "ifc"` / `method: "explicit"` level labels;
- the IFC spatial hierarchy, unless Revit can export a trustworthy equivalent.
