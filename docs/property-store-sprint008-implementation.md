# Sprint 008 — Property Store targeted optimization: implementation report

## Outcome and scope

**PASS against the measured local gates.** Only the two changes selected by the [Sprint 007 audit](property-store-targeted-performance-audit.md) were implemented: an actual-use definition scope mask and removal of `facet_index` from *new* Stores. The public Canonical Query API, source metadata, canonical metadata, property relationships, Viewer, Copilot, IFC adapter and existing Store v2 files were not modified. New Store schema version is **3**; existing v2 read support is retained.

## Implementation and compatibility

- `src/publish/canonicalPropertyStore.ts` writes `property_definitions.usage_mask`: bit **1** for actually stored instance assignments, bit **2** for actually stored type assignments, **3** for both, **0** for unused definitions. The builder accumulates these bits while creating distinct property sets and updates each used definition only once before commit. It does not trust producer-declared `scopes_json` and does not rescan 5.33 million relationships after build.
- A v3 definitions request scans only the 4,133-row definition table twice (one branch per bit), orders by scope/name/parameter ID, and appends the same three canonical identity facets. Existing v2 databases take the unchanged relationship-based SQL branch.
- New builds persist `storeVersion: 3` in `canonical-property-store.manifest.json` and `PRAGMA user_version = 3` in SQLite. Old v2 manifests and SQLite `user_version = 0` remain readable. Every Store read validates the manifest, its byte count, SQLite version and expected definition schema. Unsupported/mismatched versions and missing/corrupt manifests fail explicitly; no read performs a migration or rewrite.
- New builds neither create nor populate `facet_index` or `facet_index_lookup_idx`. The sole test-only `getFacetValues()` reader was removed; tests now cover the public Category/Family/Type canonical values and matches. Physical `elements.type_name` remains internal to the `type` facet mapping.
- A builder refuses an already-populated destination. On a failed build it removes only its newly created partial Store artifacts; it does not remove Source Metadata or an existing published Store. Reverting the code and rebuilding a new Store from retained Source Metadata is the rollback path. Existing v2 files do not need rebuilding.

The version is **internal Store schema version 3**, not a change to canonical metadata v2, Publish Package v1 or Query API semantics.

## Representative old/new benchmark

Both Stores were built by their respective **production build implementations** from the same 477,281,111-byte original Revit `source-metadata.json` and matching `object-map.json` documented in Sprint 007. The v2 build used compiled code from `b29aad2` before the implementation; the v3 build used this sprint's code. Both builds were isolated under ignored `data/property-sprint008-20260923/`, on the same Windows machine, Node 24.18.0 / SQLite 3.53.1. Both ended with production `VACUUM`; page free-list counts are zero. Build times are one observation each, **not** a distribution or isolated attribution of saved time. Query measurements are warm-OS-cache observations; no cold-disk claim is made.

| Measure | Old Store v2 | New Store v3 | Change |
| --- | ---: | ---: | ---: |
| Physical SQLite file | **274,710,528 B** (261.98 MiB) | **230,555,648 B** (219.88 MiB) | **−44,154,880 B / −16.07%** |
| Store build, one run | 44,987.81 ms | 39,918.95 ms | −5,068.86 ms observed; not a statistical speed claim |
| Definitions request, first observed | 2,670.86 ms | 14.33 ms | −2,656.53 ms |
| Definitions request, warm median | **2,680.36 ms** | **13.48 ms** | **−2,666.88 ms / 99.50%; ~199×** |
| Warm observed range (8 samples) | 2,615.35–2,700.74 ms | 11.74–20.49 ms | v3 passes **<100 ms** gate |
| Public catalogue entries | 4,104 | 4,104 | Exactly equal, including three identity facets |

A separate first benchmark pass found v2/v3 warm medians **2,637.93 / 11.52 ms**. The larger per-request v3 time than Sprint 007's 4.29-ms *SQL-only disposable prototype* includes production manifest/schema validation, connection lifecycle and result mapping; it still exceeds the required improvement by a wide margin. Actual v3 size exactly matches the Sprint 007 **projection**, now measured rather than assumed.

The v3 mask distribution is **67 unused (0), 1,800 instance-only (1), 2,231 type-only (2), 35 both (3)**. This yields **4,101 actual definition/scope rows**, plus the three facets. `sqlite_master` contains neither obsolete facet object.

### Other queries and result parity

The table shows the second comparable run's warm medians (ms; five calls per workload, first excluded). Minor variation is expected from cache and scheduler effects; there is no consistent or material regression. The Family match outlier did not recur in the first run (76.93 / 74.66 ms, v2/v3).

| Query | v2 | v3 |
| --- | ---: | ---: |
| Full selected-element properties | 2.76 | 2.81 |
| Category values / matches | 56.05 / 77.51 | 60.39 / 77.32 |
| Family values / matches | 62.84 / 75.97 | 60.58 / 87.25 |
| Type values / matches | 60.50 / 75.41 | 61.71 / 75.79 |
| System Name values / matches | 128.62 / 99.78 | 125.95 / 101.32 |

Exact-result comparison covered the full 4,104-entry catalogue, one complete selected-element property result, all returned Category/Family/Type and System Name value/count arrays, and matching sorted render-ID sets for a representative value from each facet/property. Public catalogue SHA-256 on **both** versions: `be0668f89a25d6b487541301edabfd7c14fdb5ff021760b7a669b937ab770e33`.

Beyond sample queries, the benchmark streamed and hashed **every semantic row** in `property_definitions` (common columns), `string_dictionary`, `property_values`, `property_sets`, `property_set_values`, `types`, `elements`, `levels` and `render_objects`; each complete v2/v3 table hash matched. In particular, all **5,334,657 relationship rows** have identical ordered content (SHA-256 `5eb4fc5b50dafa88f35aad6a5a69c5fe6551a2e2bf36f27abce1c98041742fd8`). Cardinalities also match exactly:

| Definitions | Unique values | Property sets | Semantic relations | Types | Elements | Render objects |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4,133 | 390,435 | 101,468 | 5,334,657 | 294 | 101,174 | 101,187 |

## Regression evidence

- Automated fixture tests exercise instance-only, type-only, both and unused declared scopes; repeated definitions and shared type properties; empty/nonempty values; exact catalogue ordering; Type facet's public `type` → internal `elements.type_name` mapping; and absence of new facet tables.
- A preserved **genuine pre-change v2 binary fixture**, generated by `b29aad2`, has no `usage_mask`, a v2 manifest and SQLite `user_version = 0`. Its catalogue, full properties, values/counts and matching render IDs match a v3 build from the same fixture source exactly. The large v2 Store built before this sprint also passed the same public benchmark against v3. No v2 file was relabelled or migrated.
- Malformed, missing, unsupported or version/size-mismatched manifests and incomplete SQLite schemas fail without changing database bytes. A failed new build leaves no partial Store artifacts; an attempted rebuild into an existing v2 destination is refused without modifying the v2 file.
- Existing IFC canonical JSON query tests pass. The fallback route in `src/server.ts` and IFC files were untouched. Public response formats and canonical definition IDs are unchanged; the Viewer requires no source-specific branch.

Validation after implementation: **86/86 backend automated tests PASS**, typecheck PASS, production build PASS. No production Viewer/Copilot/IFC/E57/upload code was changed.

## Reproduce and rollback

From `C:\Development\symetriq-converter` in PowerShell, build the current production code, use the same original source path from the Sprint 007 document, and choose a **new empty** v3 scratch directory. The v2 database for comparison must have been built by pre-change code or be an existing published v2 Store; the committed small v2 fixture is at `src/publish/fixtures/property-store-v2/`.

```powershell
npm.cmd run build
$sourcePath = 'C:\Users\Gábor\AppData\Roaming\SymetrIQ\Copilot\Exports\Hub\20260831-110345-76c151a58f90418583420ae6ed4b7256\CustomExporterPilot\source-metadata.json'
$mapPath = Join-Path (Split-Path $sourcePath) 'object-map.json'
$outputDir = 'C:\Development\symetriq-converter\data\property-sprint008-recheck-v3'
node --max-old-space-size=4096 --input-type=module -e 'import fs from "node:fs"; import {CanonicalPropertyStore} from "./dist-server/publish/canonicalPropertyStore.js"; const [sourcePath,mapPath,outputDir]=process.argv.slice(1); const source=JSON.parse(fs.readFileSync(sourcePath,"utf8")); const objectMap=JSON.parse(fs.readFileSync(mapPath,"utf8")); console.log(new CanonicalPropertyStore().build(source,outputDir,fs.statSync(sourcePath).size,0,objectMap));' $sourcePath $mapPath $outputDir
node tools/benchmarkPropertyStore.mjs data/property-sprint008-20260923/v2/canonical-property-store.sqlite data/property-sprint008-recheck-v3/canonical-property-store.sqlite
```

The benchmark tool aborts on any cardinality, full-table-row or public-result mismatch, then reports sizes and repeated query timings. `npm.cmd test`, `npm.cmd run typecheck` and `npm.cmd run build` are the validation commands. The previous Store v2 files are retained and opened read-only. For rollback, revert this sprint's code before building another new Store; discard only a failed or unaccepted **new** v3 artifact, retain original Source Metadata, and rebuild that model's Store from the source. Do not transform or delete previously published v2 files in place.

Remaining limit: this is a local backend/SQLite benchmark, not a production HTTP or manual Viewer acceptance test. The build-time comparison has one sample per version; the documented query ranges are observed samples, not p95/p99 claims.
