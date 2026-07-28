# SymetrIQ Converter

## Project server (MVP)

The project server stores uploaded IFC/LAS/LAZ files, automatically converts
IFC files to GLB, XKT and metadata JSON, and exposes project manifests to the
Viewer.

```powershell
npm install
npm run server
```

The API listens on `http://localhost:3001` by default. Project data is stored
under `data/projects` and is ignored by Git.

Keep this server running while using the Viewer development server.

Converts IFC models into the SymetrIQ Viewer package:

`IFC -> GLB (IfcConvert) -> safe GLB optimization -> XKT (xeokit-convert) + metadata JSON`

## GLB optimization (MVP)

Before `convert2xkt`, the converter applies bitwise-safe vertex welding,
geometry/accessor/material deduplication, Meshoptimizer vertex-cache
reordering, and conservative per-mesh simplification (65% triangle target,
0.1% maximum mesh-radius error). IFC product nodes are retained unchanged:
their names continue to become XKT entity IDs, so object-level selection and
the metadata mapping are preserved.

Mesh merging and node instancing are intentionally not enabled, because they
could change IFC element boundaries or picking. Simplification operates only
within each mesh and never changes the owning IFC node.
`EXT_meshopt_compression` and `KHR_mesh_quantization` are likewise not emitted
in the MVP: the downstream XKT loader does not declare a Meshopt decoder, and
quantization would introduce avoidable precision loss. The applied Meshoptimizer
reordering is lossless and still improves GPU vertex-cache locality.

Optional tuning:

- `SYMETRIQ_MESH_SIMPLIFICATION_RATIO` - retained-triangle target (default: `0.40`)
- `SYMETRIQ_MESH_SIMPLIFICATION_ERROR` - maximum relative geometric error (default: `0.002`)

## IfcConvert

Install the Windows `IfcConvert.exe` binary at `tools/ifcopenshell/IfcConvert.exe`,
or set its absolute path through the `IFCCONVERT_PATH` environment variable.

Optional conversion tuning:

- `SYMETRIQ_IFCCONVERT_THREADS` - number of geometry threads (default: 4)
- `SYMETRIQ_MESHER_LINEAR_DEFLECTION` - tessellation tolerance (default: 0.001)
- `SYMETRIQ_MESHER_ANGULAR_DEFLECTION` - angular tessellation tolerance (default: 0.5)
