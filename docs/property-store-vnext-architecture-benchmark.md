# Property Store vNext Architecture and Benchmark

## Sprint 007 decision

**Status: PASS — architecture/audit only.** No production schema, query API,
Viewer, Copilot, IFC adapter, or source contract was changed in this sprint.

The design baseline is Store v2, not the historical 3.15 GB Store v1. The
same 477,281,111-byte Revit source used by Sprint 006 was rebuilt on current
HEAD. The resulting database is 274,710,528 bytes (261.98 MiB), with the same
5,334,657 semantic property references. Store v2 remains the correct starting
point.

Three targeted changes qualify as **PROVEN BENEFIT** for Sprint 008:

1. remove the production-unused `facet_index` table and its redundant index;
2. store an actual-use scope bitmask on each property definition and use it for
   the definition catalogue;
3. remove the unused `logical_element_id` and `source_type` copies from the
   internal `render_objects` table.

The expected combined database size is approximately **221,433,856 bytes
(211.18 MiB)**, a **53,276,672-byte / 19.39%** reduction from Store v2. This is
an arithmetic projection from isolated measured components; Sprint 008 must
measure the combined implementation before accepting it.

## 1. Current Store v2 baseline

### Dataset and build

| Measure | Result |
| --- | ---: |
| Source metadata | 477,281,111 bytes / 455.17 MiB |
| Object map | 101,187 render objects |
| Store v2 | 274,710,528 bytes / 261.98 MiB |
| Store build including VACUUM | 40.25 s |
| Builder heap delta | +191,899,904 bytes |
| Builder RSS delta | +214,876,160 bytes |
| Definitions | 4,133 |
| Definitions actually used in a scope | 4,101, plus 3 canonical facets |
| Unique property values | 390,435 |
| Property sets | 101,468 |
| Semantic property references | 5,334,657 |
| Types | 294 |
| Elements | 101,174 |
| Render objects | 101,187 |

The build-memory deltas are the Store builder's existing measurements and do
not include the complete JSON parse peak. Sprint 006 measured the end-to-end
parse/projection peak at approximately 1.72 GB.

### Exact physical allocation

| Component | Bytes | Share |
| --- | ---: | ---: |
| `property_set_values` | 58,785,792 | 21.40% |
| `property_set_values_value_idx` | 58,806,272 | 21.41% |
| `facet_index` | 22,081,536 | 8.04% |
| `facet_index_lookup_idx` | 22,081,536 | 8.04% |
| Elements and indexes | 43,876,352 | 15.97% |
| Property values and indexes | 30,253,056 | 11.01% |
| Render mapping and indexes | 28,119,040 | 10.24% |
| Property sets and signature index | 9,293,824 | 3.38% |
| Definitions and parameter-ID index | 831,488 | 0.30% |
| Display dictionary and index | 487,424 | 0.18% |
| Remaining schema/types/levels | 94,208 | 0.03% |

There are no free pages after VACUUM. The 3.15 GB Store v1 figure is not used
to justify any vNext decision.

### Query baseline on current HEAD

Medians include opening a read-only SQLite connection, matching production
service behaviour.

| Query | Median |
| --- | ---: |
| Full properties for one render object | 1.49 ms |
| Property definitions | 2,491.76 ms |
| Category values | 48.08 ms |
| Category matches | 68.65 ms |
| Family values | 51.69 ms |
| Family matches | 68.70 ms |
| Type values | 50.35 ms |
| Type matches | 68.44 ms |
| System Name values | 112.39 ms |
| System Name matches (85 elements) | 93.72 ms |

The Sprint 006A Type fix is present: canonical `type` maps internally to
`elements.type_name`. The public name remains `type`.

## 2. Production consumers of physical structures

| Structure | Writer | Current reader | Classification |
| --- | --- | --- | --- |
| `property_definitions` | Store build | element retrieval, catalogue, values, matches | A — production |
| `property_values` | Store build | element retrieval, catalogue, values, matches | A — production |
| `property_sets` | Store build | instance/type inheritance and all property queries | A — production |
| `property_set_values` PK `(set,value)` | Store build | forward element-property retrieval | A — production |
| reverse index `(value)` | Store build | definitions, values and matching elements | A — production/performance |
| `types` | Store build | inherited type properties | A — production |
| `elements` | Store build | identity, facets, instance sets, query joins | A — production |
| `render_objects.render_object_id` | Store build | selected render object → source element | A — production |
| `render_objects.source_element_id` | Store build | selected-property retrieval and match joins | A — production |
| `render_objects.viewer_object_id` | Store build | filter/isolate/color match response | A — production |
| `render_objects.logical_element_id` | Store build | no reader after build validation | D — redundant copy |
| `render_objects.source_type` | Store build | no reader; authoritative object map remains retained | D — redundant copy |
| `levels` inside SQLite | Store build | no current Store query; levels are served in bootstrap metadata | E — future/internal, negligible |
| `facet_index` | Store build | `getFacetValues` only | B/D — test-only in repository, redundant in production |
| `getFacetValues` | none | one Store unit test | B — test-only |

Production routes call `getPropertyDefinitions`, `getPropertyValues`,
`getMatchingViewerObjectIds`, and element property retrieval. No route calls
`getFacetValues`. Category, Family and Type values/matches use the canonical
facet IDs but query `elements` directly.

IFC continues through the same public endpoints using canonical JSON when no
SQLite Store exists. None of the proposed physical changes alters this branch.

## 3. `facet_index` dependency analysis

`facet_index` contains 303,522 rows: one Category, Family and Type assignment
per element where present. Its `WITHOUT ROWID` primary key is already ordered
by `(facet,value,source_element_id)`. Therefore the separate
`facet_index_lookup_idx(facet,value)` duplicates the same useful prefix and is
not required even by `getFacetValues`.

More importantly, the production Canonical Query API does not read either
object. It runs the following logical paths:

- facet values: group the canonical `category`, `family`, or `type_name`
  element column;
- facet matches: filter that element column and join to `render_objects`.

### Removal benchmark

| Measure | Store v2 | Without `facet_index` | Difference |
| --- | ---: | ---: | ---: |
| Database | 274,710,528 B | 230,547,456 B | **-44,163,072 B / -16.08%** |
| Variant VACUUM | — | 2.83 s | one-time prototype operation |
| Element properties | 1.49 ms | 1.56 ms | noise |
| Definitions | 2,491.76 ms | 2,507.96 ms | noise |
| Category values/matches | 48.08 / 68.65 ms | 48.76 / 70.13 ms | noise |
| Family values/matches | 51.69 / 68.70 ms | 50.65 / 73.98 ms | noise |
| Type values/matches | 50.35 / 68.44 ms | 51.44 / 70.03 ms | noise |
| Normal values/matches | 112.39 / 93.72 ms | 112.21 / 94.61 ms | noise |

**Conclusion: PROVEN BENEFIT.** Remove both objects in Sprint 008. Replace the
test-only `getFacetValues` assertion with the production canonical facet query
path. Do not retain a physical projection for a hypothetical future consumer.

### Direct element-column indexes

Three covering indexes on `(category|family|type_name, source_element_id)`
reduce facet-value latency to 9–10 ms and matches to 42–48 ms, but consume
21,082,112 bytes. The database becomes 251,629,568 bytes, recovering only
23,080,960 bytes of the original 44,163,072-byte saving. Current unindexed
50–70 ms facet latency is already interactive.

**Classification: MARGINAL.** Do not add these indexes in Sprint 008. Revisit
only if a measured UX/SLO or a larger element count requires them.

## 4. Property-definition query root cause

The current query discovers actual definition/scope usage dynamically:

```text
property_set_values (5,334,657 rows)
  → property_values by INTEGER PK
  → property_definitions by INTEGER PK
  → property_sets by INTEGER PK
  → DISTINCT
  → ORDER BY
```

`EXPLAIN QUERY PLAN` proves a full covering-index scan of
`property_set_values_value_idx`, followed by three PK lookups per relationship.
SQLite then creates temporary B-trees for both `DISTINCT` and `ORDER BY`.
Returning 4,101 actual definition/scope records therefore costs 2.49 seconds
because usage is rediscovered from 5.33 million edges on every catalogue open.

### Candidates

| Candidate | Disk | Build cost | Query | Correctness/complexity | Decision |
| --- | ---: | ---: | ---: | --- | --- |
| Use producer `scopes_json` | 0 | 0 | a few ms | Can expose declared-but-unused scopes; not equivalent | REJECT |
| `usage_mask` on definition (`1=instance`, `2=type`) | +8,192 B measured | 5.83 s post-hoc backfill upper bound; build-time marking should be much smaller | **5.27 ms** | Simple; derives from actual assignments | **PROVEN BENEFIT** |
| Separate definition/scope summary relation | small, ~4,101 rows | small | similar to mask | More rows/index/state for the same binary fact | MARGINAL |
| Usage counters | larger than mask | small | similar | Counts have no current consumer | REJECT |
| Bitmap/materialized relation | variable | higher | fast | Excess complexity at 4,133 definitions | DEFER |

The bitmask prototype returned all 4,101 definition/scope rows byte-for-byte
equivalent to the current SQL result. The three canonical identity facets are
still appended separately, preserving the 4,104-result public catalogue. File
size increased from 274,710,528 to 274,718,720 bytes.

The measured improvement is **2,491.76 ms → 5.27 ms**, approximately **473×**
or **99.79%**. Sprint 008 should mark the mask while processing the already
available instance/type value sets; it must not perform the measured post-hoc
5.33-million-edge backfill for new stores.

## 5. Relationship storage analysis

The forward table and reverse index together use 117,592,064 bytes for
5,334,657 relationships: **22.04 bytes per semantic reference**.

- The table is already `WITHOUT ROWID` with compact INTEGER IDs and primary
  key `(property_set_id, property_value_id)`.
- Forward element-property retrieval uses that primary key by set ID.
- Values and matches require the covering reverse index by property value ID.
- SQLite INTEGER keys already use variable-width integer encoding.
- The set IDs reference 101,468 sets, exactly the 101,174 instance sets plus
  294 type sets in this dataset. Unique element properties prevent useful
  cross-element set reuse here; type sets are already stored once.

Dropping the reverse index saves 58,806,272 bytes and produces a 215,904,256-
byte database. However, `EXPLAIN` changes reverse lookup to a full table scan.
The ordinary values/matches benchmark failed to finish after more than four
minutes of CPU time, versus 112.39/93.72 ms with the index. Forward lookup
still uses the primary key, but that does not rescue filtering.

**Conclusion: keep both B-trees.** The reverse index has a concrete current
consumer and decisive benchmark justification.

| Alternative | Assessment | Decision |
| --- | --- | --- |
| Reverse index removal | 58.81 MB saving, catastrophic reverse-query regression | REJECT |
| Swap clustering to `(value,set)` | Makes reverse fast but turns element retrieval into a scan | REJECT |
| Narrower integers | SQLite varints already provide this physically | REJECT |
| `WITHOUT ROWID` | Already used | KEEP CURRENT |
| Grouped/varint property-set blobs | Could reduce forward B-tree pages but moves joins/decoding into application code | DEFER pending isolated parity benchmark |
| Compressed adjacency/inverted blobs | Could reduce both trees, but introduces update, decode and corruption complexity | DEFER |
| Instance property rematerialization | More rows and loses type deduplication | REJECT |

No relationship-layout change belongs in Sprint 008.

## 6. Dictionary opportunity analysis

### Already effective

The major semantic repetition is already removed: 5,334,657 references point
to 390,435 unique definition/raw/display tuples (7.32%). Type properties are
stored once per 294 types. Formatted strings that differ from raw display are
already dictionary encoded; the complete dictionary plus unique index is only
487,424 bytes.

### Measured identity/value cardinalities

| Data | Occurrences/unique | Stored characters before SQLite overhead |
| --- | ---: | ---: |
| Category | 101,174 / 13 | 959,291 |
| Family | 101,174 / 141 non-null values | 1,782,121 |
| Type name | 101,174 / 290 non-null values | 1,498,036 |
| Element logical IDs | 101,174 unique | 6,778,658 |
| Element source IDs | 101,174 unique | 4,552,830 |
| Repeated logical IDs in render map | 101,187 | 6,779,529 |
| Repeated source IDs in render map | 101,187 | 4,553,415 |
| Viewer IDs | 101,187 | 4,553,415 |
| Render IDs | 101,187 | 1,113,057 |
| Raw JSON lexemes | 390,435 rows / 270,895 distinct lexemes | 7,552,853 |

Category/family/type dictionary encoding has a gross text ceiling of only
4.24 million characters after `facet_index` removal. It would add dictionary
tables, unique indexes and joins to every facet/identity query. Raw-value
lexeme encoding has a 7.55 million-character gross ceiling before its own
dictionary and index overhead. Both are likely single-digit-MiB savings and
would complicate hot paths.

Logical, source, render and viewer IDs are mostly unique identities, not a
small repeated vocabulary. A global ID dictionary would require more joins
and unique indexes; it is not justified merely because distinct semantic IDs
can happen to contain equal text.

**Dictionary conclusion:** current value/display dictionary work is sufficient.
Category/family/type and raw-lexeme dictionaries are **MARGINAL**; a global
identity dictionary is **DEFERRED**. None belongs in Sprint 008.

## 7. Render mapping normalization candidate

Current production code reads only `render_object_id`, `source_element_id`,
and `viewer_object_id`. Build-time object-map validation already proves the
logical/source association, while the retained object-map package remains the
authoritative provenance record. The copied `logical_element_id` and
`source_type` columns have no current Store reader.

An isolated table prototype preserving the three consumed columns measured:

| Measure | Current table/indexes | Minimal table/indexes |
| --- | ---: | ---: |
| Allocation | 28,119,040 B | 18,997,248 B |
| Saving | — | **9,121,792 B / 32.44% of mapping / 3.32% of DB** |
| Render → source lookup | 0.0288 ms | 0.0279 ms |

**Conclusion: PROVEN BENEFIT.** This is a removal of unconsumed duplication,
not a public identity-contract change. Include it in Sprint 008, with parity
tests for selected-element retrieval and match result IDs.

## 8. Benchmark methodology

- Source: the Sprint 006 477,281,111-byte Revit Source Metadata v1 artifact
  and its 66,264,930-byte object map.
- Code baseline: Store v2 on commit `b7896ba`.
- Database page size: 4,096 bytes; all variants VACUUMed.
- Query timing: one warm-up followed by five runs; definition baseline used
  three runs and the direct-mask query seven runs. Reported value is median.
- Each public Store call opens/closes a read-only connection, as production
  does. HTTP/IIS/network latency is excluded.
- Variants were isolated database copies. No production publish workspace was
  modified.
- Physical size comes from both final file size and `dbstat` per-object pages.
- The no-reverse-index query was deliberately terminated after the suite used
  more than four minutes of CPU; the lower bound is sufficient to reject it.

Timing is machine- and cache-dependent. Semantic row equality and exact page
allocation are deterministic for this artifact; Sprint 008 must rerun the same
suite on its combined schema.

## 9. Candidate decision matrix

| Candidate | Classification | Evidence |
| --- | --- | --- |
| Remove `facet_index` and lookup index | **PROVEN BENEFIT** | -44.16 MB; no production reader; no query regression |
| Definition actual-use bitmask | **PROVEN BENEFIT** | +8 KB; 2,491.76 → 5.27 ms; identical 4,101 scope rows |
| Trim two unused render-map columns | **PROVEN BENEFIT** | -9.12 MB; lookup unchanged |
| Add three covering facet indexes | MARGINAL | Faster facets, but +21.08 MB for already-interactive paths |
| Remove reverse relationship index | REJECT | >4-minute incomplete suite versus ~100 ms |
| Recluster relationship table | REJECT | Exchanges one required fast direction for another |
| Grouped/compressed relationships | DEFER | Promising size theory, no parity/query benchmark yet |
| Category/family/type dictionary | MARGINAL | ≤4.24M-character gross opportunity, extra joins/indexes |
| Raw lexeme dictionary | MARGINAL | ≤7.55M-character gross opportunity, extra joins/indexes |
| Global identity dictionary | DEFER | Mostly unique values; broader schema/query complexity |
| Definition summary table/counters | MARGINAL/REJECT | Mask supplies the current fact more simply |
| Binary metadata formats | OUT OF SCOPE | Explicit Sprint non-goal |

## 10. Semantic parity risks

The public contract remains:

```text
definition → values/counts → matching render object IDs
category | family | type → values/counts → matching render object IDs
render object → logical/source element → full instance/type properties
```

Risks Sprint 008 must control:

- The definition usage mask must represent actual stored instance/type
  assignment, not merely producer-declared scopes.
- Existing Store v2 databases lack the mask. Runtime must detect v2 and use
  the current query as a compatibility fallback, or rebuild explicitly; it
  must not silently break existing published scenes.
- New Store schema should receive a new physical Store version even though the
  HTTP contract is unchanged.
- Removing render columns must not change object-map validation or returned
  viewer object IDs.
- Revit and future IFC Store adapters must use the same canonical facets and
  definition/scope semantics. No Revit names belong in query code.
- Source metadata, object map and bootstrap remain authoritative retained
  artifacts; the Store is a rebuildable physical projection.

## 11. Recommended vNext architecture

Keep Store v2's normalized property graph, integer IDs, fixed BLOB set
signatures, display dictionary, type deduplication, `WITHOUT ROWID` forward
relationship table and reverse value index.

Create the next physical Store version with only these differences:

1. no `facet_index` table, secondary index, or build inserts;
2. `property_definitions.usage_mask`, marked from actual instance/type
   assignments during build;
3. definition catalogue reads the mask and no longer traverses relationships;
4. `render_objects` stores only render ID, source-element link and current
   Viewer/XKT object ID;
5. v2 read compatibility for already-published Store files.

This architecture remains source-neutral. IFC can adopt it later without any
Viewer or API contract change, but IFC storage migration is not part of the
implementation scope.

## 12. Exact Sprint 008 implementation scope

1. Introduce a new internal Store schema version and preserve v2 reads.
2. Remove `facet_index`, `facet_index_lookup_idx`, and their insertion path
   from new Store builds.
3. Route any remaining internal facet helper through the same canonical
   `getPropertyValues` path used by production, or remove the unused helper.
4. Add and populate the actual-use definition scope bitmask during the normal
   build pass; rewrite the vNext catalogue query to use it.
5. Trim `render_objects` to the three currently consumed fields, while keeping
   package validation unchanged.
6. Add exact semantic parity tests for definitions/scopes, values/counts,
   matches, three facets, selected-element retrieval and render identity.
7. Re-run this large benchmark and require:
   - combined DB at or below the projected ~221.44 MB decimal range, allowing
     documented SQLite packing variance;
   - definition catalogue near the measured single-digit-ms result;
   - no material regression in element, normal property, or facet queries;
   - unchanged semantic cardinality and public JSON responses.

## 13. Sprint 008 must not change

- public Canonical Query API URLs or response semantics;
- Viewer or Copilot code;
- Revit Source Metadata or Publish Package contracts;
- IFC canonical JSON or IFC pipeline behaviour;
- Source Contract v1.1;
- property-value equality/canonicalization;
- type-property deduplication;
- relationship table/reverse-index layout;
- bootstrap metadata contract;
- transport format, upload flow, geometry pipeline, queueing or authentication;
- facet indexes unless a new measured requirement explicitly supersedes this
  Sprint 007 decision.

## 14. Final recommendation

Store v2 is already compact and fast on its main property paths. vNext should
be a surgical cleanup, not a redesign. The selected changes remove proven dead
duplication and make catalogue latency proportional to 4,133 definitions
instead of 5.33 million relationships. More aggressive dictionaries or
compressed relationship encodings should remain outside Sprint 008 until an
isolated prototype proves a material total-system benefit.
