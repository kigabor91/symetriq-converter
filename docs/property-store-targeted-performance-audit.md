# Sprint 007 — Property Store targeted performance audit

> Sprint 008 implemented and measured the two selected changes. See
> [Property Store Sprint 008 implementation report](property-store-sprint008-implementation.md)
> for production-build measurements and v2 compatibility evidence. The figures
> below are the pre-implementation audit baseline and disposable prototypes.

## Decision

**GO: a narrowly scoped Sprint 008 is justified.** Current Store v2 is already compact: the historical ~3.15-GB Store v1 is not the current architecture. The remaining confirmed outlier is the first property-definition catalogue request on a large Revit model: **2,739.70 ms warm median**, compared with 4.29 ms for an experimentally materialized *actual-use scope* bitmask on a disposable database copy. Opening Visible Properties, Filter or Display Colour requests this catalogue, so the delay is user-facing, though it does **not** block initial scene loading. A second, independently proven cleanup can remove the production-unused `facet_index` table and index, saving **44,163,072 bytes (16.08%)** without changing the tested public results. Neither change is implemented here.

This decision supersedes the broader Sprint 008 recommendation in `property-store-vnext-architecture-benchmark.md`: **do not include render-map normalization, relationship redesign or further dictionaries in Sprint 008.**

## 1. Current Store and representative benchmark

Audited repository HEAD: `c254d29502996db9cb2f0bb5e426aa24b494dd73` (2026-09-23). The last relevant Store code change was `b7896ba` (canonical Type facet mapped to SQLite `elements.type_name`); later commits did not replace the definitions query or Store schema. See `metadata-footprint-semantic-equivalence-audit.md` for the historical Store v1 comparison and `ifc-canonical-metadata-contract.md` for the separate IFC canonical JSON contract.

The original large Revit artifact remains available at:

`C:\Users\Gábor\AppData\Roaming\SymetrIQ\Copilot\Exports\Hub\20260831-110345-76c151a58f90418583420ae6ed4b7256\CustomExporterPilot\source-metadata.json`

Its matching `object-map.json` was used. No current SQLite Store artifact was found under the repository, so Store v2 was rebuilt with the **current production `CanonicalPropertyStore.build`**, in ignored `data/property-audit-20260923/`. No small synthetic fixture was extrapolated. Environment: Windows, Node 24.18.0, bundled SQLite 3.53.1, local SSD/filesystem; one process, sequential reads. No true cold-disk benchmark was claimed: the OS cache was warm after the build.

| Measure | Historical Sprint 006 | Current reproduction |
| --- | ---: | ---: |
| Source metadata | 477,281,111 B | 477,281,111 B (455.17 MiB) |
| Store v1 | 3,303,800,832 B | Historical only |
| Store v2 | 274,710,528 B | **274,710,528 B (261.98 MiB)** |
| Reduction from v1 | 91.69% | **91.69%** |
| Store version | 2 | 2 (`canonical-property-store.manifest.json`) |
| Elements / render objects | 101,174 / 101,187 | 101,174 / 101,187 |
| Definitions / unique values | 4,133 / 390,435 | 4,133 / 390,435 |
| Semantic property references | 5,334,657 | 5,334,657 |
| Types / facet assignments | 294 / — | 294 / 303,522 |
| Store build | — | 50.03 s, one run (not a distribution) |

The database has 67,068 allocated 4-KiB pages and no free-list pages. Major allocations (`dbstat`): `property_set_values` 58,785,792 B; its reverse index 58,806,272 B; `elements` plus indexes 43,876,352 B; `facet_index` **22,081,536 B**; `facet_index_lookup_idx` **22,081,536 B**; render mapping plus indexes 28,119,040 B; property values plus indexes 30,253,056 B. The table alone is **not** the 44.16-MB facet footprint; table **plus** index are.

## 2. Property-definition endpoint and verified root cause

`src/server.ts` `GET /api/projects/:projectId/models/:modelId/property-definitions` chooses `CanonicalPropertyStore.getPropertyDefinitions()` when a Store exists. If not, the IFC path derives the catalogue from canonical metadata JSON; this audit does not change that path. The Store method in `src/publish/canonicalPropertyStore.ts` runs:

```sql
SELECT DISTINCT definition.parameter_id, definition.name,
       definition.storage_type, definition.unit_type_id, sets.scope
FROM property_definitions definition
JOIN property_values value ON value.definition_key = definition.definition_key
JOIN property_set_values set_value
  ON set_value.property_value_id = value.property_value_id
JOIN property_sets sets ON sets.property_set_id = set_value.property_set_id
ORDER BY sets.scope, definition.name, definition.parameter_id;
```

It returns 4,101 actual definition/scope rows; the method appends three canonical identity facets, yielding **4,104 API entries**. Current measurement: first observed request **2,756.89 ms**; eight subsequent requests **2,795.57, 2,790.31, 2,796.69, 2,698.08, 2,654.02, 2,732.49, 2,654.61, 2,746.91 ms**; warm median **2,739.70 ms**, observed warm maximum **2,796.69 ms**. An independent 5-call run had a 2,612.21-ms warm median. Historical 2,610.62 ms is therefore reproducible in magnitude, not a stale v1 artefact. The sample maximum is a useful observed tail, **not** a statistically defensible p95/p99.

`EXPLAIN QUERY PLAN` shows a full scan of the **5,334,657-row** `property_set_values_value_idx` covering index; primary-key lookups in `property_values`, `property_definitions` and `property_sets`; then temporary B-trees for both `DISTINCT` and `ORDER BY`. The query rediscovers actual definition/scope usage from every relationship on each request. The reverse index exists and is used; this is **not** evidence of a missing simple index. The heavy work is the relationship traversal and repeated de-duplication to obtain only 4,101 output rows. Other joins are needed for the current dynamic derivation; calling them individually “redundant” without a replacement representation would be misleading.

### Actual Viewer impact

`symetriq-viewer/viewer/src/services/ProjectService.ts` calls the endpoint. In `Viewer.tsx`, `loadPropertyDefinitionCatalogs()` requests missing model catalogues in parallel, remembers successful model IDs in `catalogRequestedModelIdsRef`, and retries after errors. It is invoked by `openPropertyConfiguration()` and on opening the Filter or Display tool, **not** by the initial scene-loading path. Visible Properties opens immediately but shows “Loading available properties...” until the result arrives; Filter and Display also cannot present the full field catalogue until then. Thus this is ordinarily one network request per model per scene session, but it delays common property-configuration, filtering and colouring workflows by roughly 2.6–2.8 seconds on this large Store. It does not justify optimizing the already ~2-ms selected-element lookup.

## 3. Targeted alternatives, measured on disposable copies

| Candidate | Current/experimental warm median | Net effect | Storage / build cost | Semantic and complexity assessment |
| --- | ---: | --- | --- | --- |
| Current `DISTINCT` join | **2,739.70 ms** | Baseline | None | Correct, but scans 5.33m links per request |
| Two `EXISTS` branches, same schema | **2,123.09 ms** | ~617 ms / ~22.5% faster | None | Exact 4,101-row equality; still ~2.1 s, insufficient first-use UX gain |
| `property_definitions.usage_mask` (`1=instance`, `2=type`) | **4.29 ms** | ~2,735 ms / **99.84% faster** | +8,192 B after `VACUUM`; prototype backfill 1.95 s; new-build marking cost unmeasured | Exact 4,101-row equality; small internal schema change; must mark *actual stored assignment*, never blindly use declared `scopes_json` |

The `EXISTS` alternative scans 4,133 definitions twice and uses correlated indexed probes plus ordering B-trees. Seven warm experimental runs ranged 2,072.90–2,144.33 ms. It does not materially change the user's wait. The bitmask copy produced **identical ordered JSON**, SHA-256 `e76e681a00db54de789cfc372fac3df4e25ff72818beae0a3eae1f92c3edc913`, for both 4,101-row SQL outputs. The public three-facet append remains unchanged. Nine mask-query timings were 6.116, 6.679, 7.051, 4.318, 4.233, 4.254, 4.185, 4.185, 4.387 ms. This prototype backfilled the mask from current relationships solely for benchmarking; a new build should mark membership while ingesting the already-known instance/type assignments. Its measured +8 KiB assumes a compacted DB; the pre-`VACUUM` experimental copy was +98 KiB. Both are negligible against 261.98 MiB.

**Decision threshold:** the current 2.6–2.8-s response directly delays first use of a common interface; the no-schema rewrite saves only ~0.6 s and leaves a >2-s wait. A mask saves ~2.7 s at ~8 KiB compacted overhead and matches exact results. This is a practical, evidence-based reason for the narrow schema change, not an arbitrary sub-millisecond target. Sprint 008 should require <100 ms warm median on this dataset, a conservative allowance above the measured 4–7 ms, while preserving the public catalogue byte-for-byte after stable ordering. Existing Store v2 files must retain their current query as a compatibility fallback unless explicitly rebuilt.

## 4. `facet_index` necessity and size

`CanonicalPropertyStore.build()` creates and populates `facet_index(facet,value,source_element_id)` and `facet_index_lookup_idx(facet,value)`. The table is `WITHOUT ROWID` with primary-key prefix `(facet,value)`, so the secondary index duplicates that prefix for its sole query. `getFacetValues()` reads this table, but `rg` found only **one test call** (`src/publish/canonicalPropertyStore.test.ts`) and no production route/caller. The production canonical Category/Family/Type values and matching render IDs are resolved by `getPropertyValues()` / `getMatchingViewerObjectIds()` against `elements.category`, `elements.family`, and **`elements.type_name`**, respectively, plus `render_objects`. The public facet remains `type`; SQLite's `type_name` is not exposed.

On a disposable copy, dropping both objects and running `VACUUM` reduced the database from **274,710,528 to 230,547,456 B**: exactly **44,163,072 B (16.08%)**; `VACUUM` took 3.29 s in this isolated experiment. Full-result hashes were equal for the catalogue, one selected element, Category/Family/Type values and matches, and System Name values and matches. A short second-run latency check gave current vs facetless medians (ms): catalogue **2,612.21 / 2,598.47**; Category values **53.95 / 52.46**; Type values **57.08 / 59.49**; System Name values **123.20 / 123.79**. Differences are noise at this sample size, not evidence of a regression or speedup. Existing `getFacetValues()` would break if left intact; Sprint 008 must remove or redirect that **test-only helper** and update its test to assert the production canonical facet API instead. Existing v2 readers must remain supported. **Conclusion: apparently unused in production, proven redundant for tested canonical queries, substantial storage benefit.**

## 5. Query regression baseline and semantic parity

All timings below are current warm medians on the reproduced v2 Store (five calls per query, first excluded; conventional mean-of-middle-two median for four warm samples). IDs/results were compared, not merely counted. System Name resolved to `canonical:instance:bip:-1140324` in this source fixture.

| Query | Warm median | Result | Semantic check |
| --- | ---: | ---: | --- |
| Full selected-element properties | 1.63 ms | One complete element object | Same SHA-256 before/after facet removal |
| Category values / one-value matches | 53.17 / 73.84 ms | 13 values; selected “Air Terminals”: 336 render IDs | Exact values, counts and sorted render-ID hash equal |
| Family values / one-value matches | 57.94 / 73.68 ms | 141 values; selected family: 2 render IDs | Exact result hashes equal |
| Type values / one-value matches | 59.07 / 74.72 ms | 290 values; selected “1 tálcás mosogató”: 285 render IDs | Exact result hashes equal; Type fix intact |
| System Name values / one-value matches | 122.12 / 100.77 ms | 4,892 values; selected empty display: 85 render IDs | Exact result hashes equal |
| Property definitions | 2,739.70 ms | 4,104 catalogue entries | Exact public hash `be0668f89a25d6b487541301edabfd7c14fdb5ff021760b7a669b937ab770e33` before/after facet removal; mask SQL rows exactly equal |

The one-value matches are representative samples, not an exhaustive proof for all 5.33m references. Existing automated tests remain necessary; Sprint 008 must add scope-edge and old-Store compatibility cases. IFC remains on the canonical JSON fallback and must continue to return the same source-neutral API shapes; no Viewer or IFC adapter change is proposed.

## 6. Sprint 008 — exact narrow scope and rollback

Only two physical changes are justified:

1. In `src/publish/canonicalPropertyStore.ts`, add an internal **actual-use scope mask** to newly built definitions and mark it from actual stored instance/type property assignments during the build. Query the mask for new Stores; keep the existing join query for already-published v2 Stores. Give the new internal Store schema an explicit version in its manifest. Do **not** use producer-declared scopes as the usage source.
2. Omit `facet_index`, its secondary index and build inserts from new Stores. Remove/redirect test-only `getFacetValues()` to the production canonical facet path, updating `src/publish/canonicalPropertyStore.test.ts`. Existing v2 files must remain readable.

Expected compacted new-Store size from isolated arithmetic: **230,555,648 B** (base minus 44,163,072 plus 8,192), **44,154,880 B / 16.07%** smaller than v2. This is a projection, **not** a measured combined implementation; Sprint 008 must measure the actual finished DB. Expected definitions median: low single-digit milliseconds, with a **<100-ms warm-median acceptance bound** on the same source and hardware. Facet, match and selected-element query latency must show no material regression relative to the table above. Full catalogue, exact values/counts and render-ID sets must match, including `type → elements.type_name`; canonical IDs and response shapes must not change. Run tests, typecheck, production build, and a large-data end-to-end query parity benchmark.

No render-map column trimming, relationship re-encoding, new dictionaries, IFC storage migration, Viewer change, Copilot change or public API alteration. No production code was changed in Sprint 007.

**Rollback:** retain old v2 Store files and the v2 read branch; if the new build/query fails parity or latency gates, revert the code change and rebuild affected new Stores from retained Source Metadata. Do not rewrite existing production Store files in place. The Store manifest version and published property references should make the recovery path explicit before release.

**Model recommendation:** GPT-6 Sol / Medium for Sprint 008. The mask and v2 compatibility path require a small but real schema-version transition and semantic edge-case judgement. GPT-6 Luna / Max is **not** recommended as the implementation pilot for this scope; its suitability would improve only if the work were reduced to a fully specified, schema-neutral SQL rewrite. An independent Sol review is useful, but passing tests alone is not evidence of a 99% regression-free guarantee.

## 7. Reproduction notes and remaining uncertainty

Run from `C:\Development\symetriq-converter` in PowerShell. This rebuilds the representative Store in an isolated ignored directory; choose another scratch path if it already exists:

```powershell
$sourcePath = 'C:\Users\Gábor\AppData\Roaming\SymetrIQ\Copilot\Exports\Hub\20260831-110345-76c151a58f90418583420ae6ed4b7256\CustomExporterPilot\source-metadata.json'
$mapPath = Join-Path (Split-Path $sourcePath) 'object-map.json'
$auditDir = 'C:\Development\symetriq-converter\data\property-audit-20260923'
New-Item -ItemType Directory -Force -Path $auditDir | Out-Null
npm.cmd run build
node --max-old-space-size=4096 --input-type=module -e 'import fs from "node:fs"; import {CanonicalPropertyStore} from "./dist-server/publish/canonicalPropertyStore.js"; const [sourcePath,mapPath,outputDir]=process.argv.slice(1); const source=JSON.parse(fs.readFileSync(sourcePath,"utf8")); const objectMap=JSON.parse(fs.readFileSync(mapPath,"utf8")); console.log(new CanonicalPropertyStore().build(source,outputDir,fs.statSync(sourcePath).size,0,objectMap));' $sourcePath $mapPath $auditDir
```

Production-method repeated timing (OS cache warm after build; output count should be 4,104):

```powershell
node --input-type=module -e 'import {performance} from "node:perf_hooks"; import {CanonicalPropertyStore} from "./dist-server/publish/canonicalPropertyStore.js"; const p="data/property-audit-20260923/canonical-property-store.sqlite"; const s=new CanonicalPropertyStore(); for(let i=0;i<9;i++){const t=performance.now(); const rows=s.getPropertyDefinitions(p); console.log(i,rows.length,performance.now()-t)}'
```

For `dbstat` and the plan, run through Node's `DatabaseSync` (`node:sqlite`) against this scratch DB; the relevant SQL is above:

```sql
SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC;
EXPLAIN QUERY PLAN SELECT DISTINCT definition.parameter_id, definition.name,
 definition.storage_type, definition.unit_type_id, sets.scope
 FROM property_definitions definition
 JOIN property_values value ON value.definition_key=definition.definition_key
 JOIN property_set_values set_value ON set_value.property_value_id=value.property_value_id
 JOIN property_sets sets ON sets.property_set_id=set_value.property_set_id
 ORDER BY sets.scope,definition.name,definition.parameter_id;
```

The tested mask-query form was:

```sql
SELECT parameter_id,name,storage_type,unit_type_id,'instance' AS scope
FROM property_definitions WHERE (usage_mask & 1) != 0
UNION ALL
SELECT parameter_id,name,storage_type,unit_type_id,'type' AS scope
FROM property_definitions WHERE (usage_mask & 2) != 0
ORDER BY scope,name,parameter_id;
```

The benchmark copies, including the test-only `ALTER TABLE`, facet drops and `VACUUM`, were confined to ignored scratch DBs. Outstanding before release: measure true cold-disk latency and production HTTP time in the deployed environment; quantify new-build mask-marking overhead (the 1.95-s post-hoc prototype is not that measurement); verify v2 fallback against a published Store and full IFC/Viewer integration; measure the combined vNext DB rather than relying on isolated arithmetic. None prevents the **GO** decision because the large-data outlier, its current consumer, exact-result prototype and storage opportunity were reproduced.
