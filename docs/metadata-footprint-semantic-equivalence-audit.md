# Metadata Footprint & Semantic Equivalence Audit

**Sprint:** 006  
**Date:** 2026-09-02  
**Repository:** `symetriq-converter`  
**Scope:** Audit only; no schema, pipeline, API, Viewer, Copilot or Source Contract change  
**Invariant:** Hub Required Source Contract v1.1 remains authoritative. Physical storage may change, but source information and canonical query semantics may not.

## 1. Executive Summary

The reported 3.15 GB Revit Property Store was reproduced from the original
477,281,111-byte (`455.17 MiB`) source metadata artifact and the historical
Store v1 implementation at commit `c4bd2b5`.

| Representation | Exact bytes | MiB | Source amplification | Bytes/property |
| --- | ---: | ---: | ---: | ---: |
| Revit source metadata | 477,281,111 | 455.17 | 1.000x | 89.47 |
| Historical Property Store v1 | 3,303,800,832 | 3,150.75 | **6.922x** | 619.31 |
| Current Property Store v2 | 274,710,528 | 261.98 | **0.576x** | 51.50 |

The 3.15 GB artifact is therefore **not the current HEAD representation**.
The current v2 store is 91.69% smaller while retaining the same 4,133
definitions, 5,334,657 semantic property references, 294 types, 101,174
elements and 101,187 render objects.

The historical amplification was overwhelmingly physical:

1. 64-character TEXT hashes were repeated in the 5.33-million-row
   property-set relationship and in two indexes: 61.20% of the whole DB.
2. Each nearly unique element property set stored a long JSON signature
   containing all those hashes, then indexed that signature: 29.30%.
3. The actual unique raw-value JSON payload was only 7.55 MB. The large DB was
   not carrying seven times more unique semantic values.

The premise that comparable IFC metadata is inherently only “a few tens of
MB” is not supported by the available artifacts. Seven current IFC canonical
metadata files total 549,467,997 bytes, 119,126 elements and 5,903,097 stored
properties. Normalized bytes/property are 89.47 for Revit source metadata,
88.41 for the representative MEP IFC and 93.08 for the local IFC aggregate.
The source representations are therefore in the same size class per property.

The current v2 store still has measurable design pressure: its relationship
table and reverse index occupy 42.81%, an unused-by-production facet structure
occupies 16.08%, and the definition catalogue query takes a median 2.61 s.
These are Sprint 007 inputs, not changes made by this audit.

## 2. Revit Source Metadata Profile

### 2.1 Reproducible artifact

```text
C:\Users\Gábor\AppData\Roaming\SymetrIQ\Copilot\Exports\Hub\
20260831-110345-76c151a58f90418583420ae6ed4b7256\CustomExporterPilot\
source-metadata.json
```

The paired `object-map.json` from the same directory was used. This export
predates the Level Catalog addition and therefore has zero levels; that does
not affect its property-footprint suitability.

| Metric | Value |
| --- | ---: |
| Source bytes | 477,281,111 |
| Elements | 101,174 |
| Render objects | 101,187 |
| Types | 294 |
| Parameter definitions | 4,133 |
| Unique definition names | 2,350 |
| Instance property values | 5,322,480 |
| Type property values | 12,177 |
| Total property values | 5,334,657 |
| Properties/element | 52.73 |
| Source bytes/element | 4,717.43 |
| Source bytes/property | 89.47 |
| Categories / families / type names | 13 / 141 / 290 |

The Hub bootstrap projection is 53,328,838 bytes (`50.86 MiB`), 11.17% of
the source file. Parse time was 2.74 s and projection plus serialization was
0.35 s. The profiling process peaked at approximately 1.72 GB RSS while
holding the parsed source, object map, canonical object graph and serialized
bootstrap concurrently. This is a process-level peak, not isolated Store
builder memory.

Definition metadata is already stored once per definition. The 4,133
definitions contain 2 source values, 183 built-in IDs, 27 parameter groups,
5 storage types, 59 spec types and 24 unit types. Duplicate display names do
not imply equivalent definitions: for example `D` and `L1` each occur under
27 stable definition IDs and may belong to different families/scopes.

### 2.2 Top 20 properties by occurrence

| Property | Occurrences | Source value bytes |
| --- | ---: | ---: |
| Category (`bip:-1140363`) | 101,468 | 1,775,618 |
| Category (`bip:-1140362`) | 101,468 | 1,775,618 |
| Design Option | 101,468 | 405,872 |
| Edited by | 101,468 | 202,936 |
| Workset | 101,468 | 1,432,801 |
| Export to IFC | 101,174 | 809,392 |
| IfcGUID | 101,174 | 4,654,004 |
| Phase Demolished | 101,174 | 607,044 |
| Phase Created | 101,174 | 809,392 |
| Family and Type | 101,174 | 4,247,774 |
| Family | 101,174 | 2,537,130 |
| Type | 101,174 | 2,258,663 |
| Type Id | 101,174 | 1,500,734 |
| System Classification | 100,594 | 3,221,750 |
| System Name | 100,578 | 1,544,702 |
| System Abbreviation | 98,723 | 806,326 |
| Size | 95,724 | 1,021,258 |
| Overall Size | 95,394 | 1,954,562 |
| Insulation Thickness | 95,394 | 500,302 |
| System Type | 93,102 | 3,743,926 |

### 2.3 Top 20 properties by serialized source value bytes

| Property | Occurrences | Source value bytes |
| --- | ---: | ---: |
| IfcGUID | 101,174 | 4,654,004 |
| Family and Type | 101,174 | 4,247,774 |
| System Type | 93,102 | 3,743,926 |
| Loss Method | 43,804 | 3,241,496 |
| System Classification | 100,594 | 3,221,750 |
| Family | 101,174 | 2,537,130 |
| Segment Description | 46,337 | 2,457,148 |
| Type | 101,174 | 2,258,663 |
| Overall Size | 95,394 | 1,954,562 |
| Category (`bip:-1140363`) | 101,468 | 1,775,618 |
| Category (`bip:-1140362`) | 101,468 | 1,775,618 |
| Pipe Segment | 46,337 | 1,734,276 |
| Application | 3,568 | 1,712,640 |
| System Name | 100,578 | 1,544,702 |
| Type Id | 101,174 | 1,500,734 |
| Volume | 50,637 | 1,467,120 |
| Workset | 101,468 | 1,432,801 |
| Roughness | 46,337 | 1,429,309 |
| Material | 46,337 | 1,365,393 |
| Area | 49,948 | 1,320,655 |

## 3. Current Property Store Schema

The current implementation is
`src/publish/canonicalPropertyStore.ts`, Store version 2.

| Table | Row count | Columns and physical types | Key structure |
| --- | ---: | --- | --- |
| `property_definitions` | 4,133 | integer key; parameter/name/scopes/source/BIP/GUID/group/storage/spec/unit TEXT; flags INTEGER | INTEGER PK; UNIQUE `parameter_id` |
| `string_dictionary` | 15,112 | integer key, value TEXT | INTEGER PK; UNIQUE value |
| `property_values` | 390,435 | integer ID/definition key, raw JSON TEXT, optional display integer ID | INTEGER PK; UNIQUE definition/raw/display |
| `property_sets` | 101,468 | integer ID, scope TEXT, SHA-256 BLOB | INTEGER PK; UNIQUE signature hash |
| `property_set_values` | 5,334,657 | set/value INTEGER pair | composite PK, `WITHOUT ROWID` |
| `types` | 294 | IDs/names TEXT, property-set INTEGER | TEXT PK; FK to set |
| `elements` | 101,174 | logical/source/type/category/family/type-name TEXT, set INTEGER | logical TEXT PK; source UNIQUE |
| `levels` | 0 in sample | ID/name/source/method TEXT, elevation REAL | TEXT PK |
| `render_objects` | 101,187 | render/logical/source/viewer/source-type TEXT | render TEXT PK; viewer index |
| `facet_index` | 303,522 | facet/value/source-element TEXT | composite PK, `WITHOUT ROWID` |

Explicit secondary indexes are:

- `property_values_definition_idx(definition_key)`;
- `property_set_values_value_idx(property_value_id)`;
- `elements_type_idx(type_id)`;
- `render_objects_viewer_idx(viewer_object_id)`;
- `facet_index_lookup_idx(facet, value)`.

SQLite also creates UNIQUE/PK autoindexes for TEXT and composite constraints.
Foreign keys document relationships, although the builder does not enable
`PRAGMA foreign_keys=ON` during creation.

## 4. SQLite Physical Footprint

Both stores were built from the exact same source/object map on the same
machine using SQLite page size 4,096 and followed by `VACUUM`.

### 4.1 Historical Store v1: exact decomposition

| Component (table plus relevant indexes) | Bytes | DB % |
| --- | ---: | ---: |
| Property-set/value relationship | 2,022,035,456 | **61.20%** |
| Property sets and signature indexes | 967,979,008 | **29.30%** |
| Property values and indexes | 106,807,296 | 3.23% |
| Redundant definition/value structure | 71,364,608 | 2.16% |
| Facet structure | 55,558,144 | 1.68% |
| Elements and indexes | 50,982,912 | 1.54% |
| Render-object mapping and indexes | 28,119,040 | 0.85% |
| Definitions, types, levels, schema/other | 974,848 | 0.03% |
| **Total** | **3,303,800,832** | **100%** |

Tables consume 1,410,408,448 bytes (42.69%); indexes consume 1,893,376,000
bytes (57.31%). There are zero free-list pages after `VACUUM`. `dbstat`
reports 237,131,925 bytes (7.18%) of internal page unused space; this overlaps
the table/index allocation above and is not an additional component.

The three physical copies of the relationship keyspace are:

- table: 800,079,872 bytes;
- composite PK autoindex: 809,213,952 bytes;
- reverse value index: 412,741,632 bytes.

### 4.2 Current Store v2: exact decomposition

| Component (table plus relevant indexes) | Bytes | DB % |
| --- | ---: | ---: |
| Property-set/value relationship | 117,592,064 | **42.81%** |
| Facet structure | 44,163,072 | 16.08% |
| Elements and indexes | 43,876,352 | 15.97% |
| Property values and indexes | 30,253,056 | 11.01% |
| Render-object mapping and indexes | 28,119,040 | 10.24% |
| Property sets and signature index | 9,293,824 | 3.38% |
| Definitions | 831,488 | 0.30% |
| Display string dictionary | 487,424 | 0.18% |
| Types, levels and schema | 94,208 | 0.03% |
| **Total** | **274,710,528** | **100%** |

Tables consume 144,609,280 bytes (52.64%); indexes consume 130,097,152
bytes (47.36%). There are zero free-list pages and 4,096 unclassified schema
bytes. The 91.69% v1→v2 reduction came from physical representation, not from
dropping semantic rows.

## 5. Cardinality & Repetition Analysis

| Measure | Total | Unique | Repetition evidence |
| --- | ---: | ---: | ---: |
| Definitions | 4,133 | 4,133 stable IDs / 2,350 names | Name alone is not identity. |
| Semantic property references | 5,334,657 | 390,435 definition/raw/display tuples | Only 7.32% of references are unique tuples. |
| Raw JSON values in unique tuples | 390,435 | 270,895 strings independent of definition | Considerable cross-definition repetition. |
| Non-default display strings in v2 dictionary | references through tuples | 15,112 | Dictionary payload is only 114,289 characters. |
| Categories | 101,174 element rows | 13 | Highly repeated. |
| Families | 101,174 element rows | 141 | Highly repeated. |
| Type names | 101,174 element rows | 290 | Highly repeated. |
| Logical/source IDs | 101,174 each | 101,174 each | Semantically unique but repeated across tables/indexes. |

Unique stored raw types are 274,396 REAL (70.28%), 110,220 TEXT (28.23%)
and 5,819 INTEGER (1.49%). Their JSON text is 7,552,853 characters total.

Highly repeated raw values include `0` (700,496 references), `-1`
(255,012), empty string (103,825) and `3` (102,023). Repeated formatted
values include `0 mm` (193,585), `None` (101,236), `Phase 1` (101,174),
`By Type` (101,174), the common workset (101,174), `Pipes` (92,700) and
`Pipe Fittings` (81,460).

Historical v1 physically stored:

- 714,844,038 characters of hash IDs in `property_set_values` alone;
- 376,773,258 characters of JSON property-set signatures;
- 30,964,613 characters in the separate definition/value mapping;
- 26,159,145 characters of property-value IDs;
- 6,778,658 repeated property-set ID characters in elements.

Those strings were also copied into B-tree indexes. By comparison, the raw
unique property-value payload was 7.55 MB.

## 6. Instance vs Type Analysis

The producer's type deduplication is preserved.

| Scope | Source values | Stored v2 relationship rows |
| --- | ---: | ---: |
| Instance | 5,322,480 | 5,322,480 |
| Type | 12,177 | 12,177 |

Type property sets are linked once to each of the 294 types. They are **not**
materialized onto every element. Materializing them per instance would create
2,665,027 effective type-value occurrences instead of 12,177 stored links —
an avoidable 219x expansion of the type-property relationship.

`property_sets` has exactly 101,468 rows, equal to 101,174 elements plus 294
types. In this artifact no two complete property sets deduplicate. This is
expected because per-element values such as GUID/identity make each complete
signature unique. Value-level deduplication remains effective: 5.33 million
references point at 390,435 value tuples.

## 7. Source → Store Amplification

Historical v1 amplification is 6.922x. The semantic cardinality did not
expand: both v1 and v2 store the same definition, value-reference, type,
element and render-object counts. The amplification decomposition is:

- **representation expansion:** long SHA-derived TEXT IDs in relationship
  rows and indexes;
- **signature expansion:** full JSON lists of property-value hashes stored and
  indexed for nearly every element;
- **index expansion:** 57.31% of v1 pages are indexes, many repeating those
  long keys;
- **accidental duplication:** `definition_value_index` duplicates a relation
  already derivable from `property_values.parameter_id`;
- **SQLite structural/internal overhead:** 7.18% internal unused bytes, zero
  free pages;
- **semantic expansion:** none between source and Store; 5.33 million
  relationships already exist in the producer graph.

Current v2 uses integer relationship IDs, a fixed 32-byte BLOB signature and
a display-string dictionary. It is 0.576x the source size and 51.50 bytes per
semantic property reference.

## 8. IFC vs Revit Comparison

There is no SQLite Property Store for current IFC models. IFC uses canonical
JSON directly; query endpoints parse and scan that JSON. Comparison therefore
uses source/canonical logical payloads, not DB-vs-JSON file size.

| Dataset | Bytes | Elements | Properties | Props/element | Bytes/element | Bytes/property |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Revit source | 477,281,111 | 101,174 | 5,334,657 | 52.73 | 4,717 | **89.47** |
| Representative MEP IFC | 98,942,895 | 19,335 | 1,119,108 | 57.88 | 5,117 | **88.41** |
| Largest local IFC | 230,698,300 | 40,305 | 2,593,246 | 64.34 | 5,724 | **88.96** |
| Seven local IFC files combined | 549,467,997 | 119,126 | 5,903,097 | 49.55 | 4,612 | **93.08** |

The local IFC aggregate is not one federated model and definitions can repeat
between files. It is nevertheless strong evidence that comparable semantic
volume, not source format alone, controls JSON size. Small IFC metadata files
in the repository correspond to smaller element/property populations.

IFC property-set counts are high because sets are represented per IFC object
and include both exported Revit groups and IFC Psets. For example, the
representative MEP IFC has 213,710 sets and 1,119,108 stored properties for
19,335 elements. Revit source instead has explicit definition and type tables
plus per-element instance arrays.

## 9. Semantic Equivalence Analysis

Representative Revit and IFC MEP elements were inspected for Pipe, Duct,
Pipe/Duct Fitting, Mechanical Equipment/energy conversion or moving devices,
family/proxy elements and generic models.

| Information class | Revit source | IFC canonical | Equivalence finding |
| --- | --- | --- | --- |
| Identity | logical/source IDs, family/type/category, Revit IDs | GlobalId/type/name plus exported identity properties | Functionally equivalent; identifiers are source-native, not equal strings. |
| Classification | category, family/type, Classification/OmniClass/custom codes | IFC entity type, Other/Identity Psets, custom classification fields | Equivalent class exists; structure and granularity differ. |
| Dimensions | size, diameter, width/height, elevations, fitting dimensions | Dimensions/Constraints/Mechanical Psets and IFC quantities | Broad overlap. Revit exposes more authoring parameters/formula inputs. |
| Systems | name/type/classification/abbreviation, flow and pressure data | Mechanical/Mechanical-Flow Psets, system fields | Strong overlap for MEP objects. |
| Material | source Material and segment properties | Mechanical/material properties where exported | Conditional overlap, exporter-dependent. |
| Manufacturer/product | type Model/Manufacturer/URL/description and custom product data | Identity/type/custom Psets when exported | Revit source is often richer and explicitly type-scoped. |
| Instance/type | Explicitly separated, 294 deduplicated types | Commonly flattened into object-associated Psets | Same information class; Revit retains clearer ownership. |
| Quantities | Native area/volume/length and parameter values | IFC quantity/Pset fields plus exported Revit values | IFC may add standard quantity semantics; overlap is substantial. |
| Custom/project data | Complete accessible project/shared/family parameters | Only fields selected by IFC export configuration | Revit is generally more complete for authoring-specific LOI. |
| Authoring internals | host, workset, phase, design option, BIP/spec/unit IDs | Some exported values, not stable source-definition metadata | Genuine Revit-only semantic detail. |

Conclusion: Revit does preserve some genuinely richer authoring semantics,
especially complete accessible parameters and explicit instance/type ownership.
However, the observed source payload is not abnormally large per property,
and the 3.15 GB Store was not caused by a sevenfold semantic advantage over
IFC. It was a physical key/signature/index representation problem.

## 10. Query Necessity Analysis

| Stored information | Current capability | Logical necessity | Physical observation |
| --- | --- | --- | --- |
| Render → logical/source mapping | selection and element retrieval | Required | Mapping is necessary; repeated long IDs across table/index are representation choices. |
| Definitions, names and scope | Visible Properties/search/catalogue | Required | Stable ID is required; duplicate display names cannot be merged blindly. |
| Raw/display values | Show All, distinct values, filters, coloring | Required | Preserve semantics; dictionary/reference representation may vary. |
| Element/type property membership | retrieval and match queries | Required | 5.33M logical edges are necessary; key width/index layout are not contractual. |
| Definition → values lookup | distinct values and saved views | Required query result | Historical `definition_value_index` was physically redundant. |
| Value → matching render objects | filter/isolate/color | Required query result | Some inverted access path is needed; exact index schema is not. |
| Category/family/type | facets and compact identity | Required when source exposes them | Current API reads `elements`; `facet_index` is only used by `getFacetValues` and its test, not production routes. |
| Complete source metadata file | Source Contract preservation/reprocessing | Required durable source information | Must not be confused with the optimized query projection. |
| Bootstrap identity | initial scene/selection | Required | Full property graph is correctly excluded. |

The current code also exposes an audit finding: Type facet value/match queries
generate SQL against `elements.type`, while the physical column is
`elements.type_name`. The reproducible result is `no such column: e.type`.
Category and Family work. This is a localized functional defect to schedule
outside this audit; it was not changed here.

## 11. Duplication Taxonomy

### Necessary semantic duplication

- The same value legitimately belongs to many different elements.
- Every element/property membership remains a separate logical edge.
- Source, logical and render identity may need distinct values and mappings.
- Type values must be inherited by many instances, although stored once.

### Avoidable physical duplication

- Historical SHA TEXT IDs repeated in relationship tables and indexes.
- Historical JSON property-set signatures containing complete hash lists.
- Repeated category/family/type TEXT values in element and facet structures.
- Multiple copies of logical/source/viewer IDs across identity tables/indexes.

### Query index overhead

- Reverse property-value lookup index: required by current match workloads,
  but its key representation dominates when keys are long.
- Element type and viewer-object indexes support active joins.
- UNIQUE indexes enforce identity and dedup invariants.

### Accidental duplication

- Historical `definition_value_index`: definition/value relation already
  exists in `property_values`.
- Current `facet_index` plus its prefix index duplicates values already held
  in `elements`; production Query API does not call `getFacetValues`.
- Historical signature table plus UNIQUE signature index duplicated hundreds
  of MB of long JSON.

### Unknown / requires design validation

- Whether all explicit reverse indexes outperform narrower alternatives on
  production workloads.
- Whether raw JSON lexical identity is the desired numeric/value equality
  semantics for every source type.
- Whether object-map IDs can share a dictionary without harming revision-local
  identity guarantees.

## 12. Current Performance Baseline

Hardware-specific figures below are five-run medians on the audit machine.
Methods open a read-only SQLite connection per call, matching current service
behaviour. No HTTP/proxy time is included.

### 12.1 Build and memory

| Measure | Current v2 | Historical v1 |
| --- | ---: | ---: |
| Build + VACUUM | 46.32 s | 416.29 s |
| Final DB | 274.71 MB decimal | 3,303.80 MB decimal |
| Builder reported RSS delta | +214.2 MB | Not reliable after long GC/VACUUM |
| End-to-end parse/projection peak RSS | ~1.72 GB | Not separately measured |

### 12.2 Current v2 queries

| Query | Result count | Median | Notable cold sample |
| --- | ---: | ---: | ---: |
| Element full properties | 81 | 1.91 ms | 6.83 ms |
| Property definitions | 4,104 | **2,610.62 ms** | similar on all runs |
| System Name distinct values | 4,892 | 119.32 ms | 121.17 ms |
| System Name single-value matches | 85 | 98.52 ms | 726.82 ms |
| Category facet values | 13 | 50.82 ms | 51.83 ms |
| Category facet matches | 336 | 71.43 ms | 75.03 ms |
| Family facet values | 141 | 54.18 ms | 58.14 ms |
| Family facet matches | 2 | 73.17 ms | 75.16 ms |
| Type facet values/matches | error | N/A | `no such column: e.type` |

The definitions query joins through all set/value relationships and applies
`DISTINCT`; this explains why catalogue retrieval is slower than value/match
queries despite returning only 4,104 definitions.

### 12.3 IFC canonical JSON comparison

On the 98.94 MB representative MEP IFC, each query reparses and scans the JSON:

| Query | Median |
| --- | ---: |
| Property definition scan (917 results) | 1,630.05 ms |
| System Name distinct values (571) | 1,297.64 ms |
| System Name selected-value query | 794.64 ms |
| Category values (14) | 746.18 ms |
| Family values (118) | 743.57 ms |
| Type values (144) | 748.57 ms |

This confirms that the Revit SQLite store is materially faster for element,
value and match retrieval. The slow v2 definition query is an implementation
outlier, not evidence that the property graph should be discarded.

## 13. Root Cause Ranking

Historical 3.15 GB Store v1, measured against total allocated DB bytes:

| Rank | Root cause | Weight | Evidence |
| --- | --- | ---: | --- |
| #1 | Long TEXT IDs in property-set/value table plus PK/reverse indexes | **61.20% dominant** | Exact `dbstat`: 2,022,035,456 bytes; 714.84M ID characters in table payload before index copies. |
| #2 | Full JSON property-set signatures plus signature indexes | **29.30% dominant** | Exact `dbstat`: 967,979,008 bytes; 376.77M signature characters. |
| #3 | Property-value TEXT IDs and indexes | **3.23% significant** | Exact `dbstat`: 106,807,296 bytes. |
| #4 | Redundant definition/value table and PK | **2.16% significant** | Exact `dbstat`: 71,364,608 bytes. |
| #5 | Facet, element and render identity structures | **4.08% combined** | Necessary semantics mixed with avoidable text/index duplication. |
| Free pages | **0%** | `VACUUM` completed; file size is live allocation, not abandoned space. |

Internal page slack is 7.18% but overlaps the components above. It must not be
added again. Semantic richness determines the number of relationships, but
does not explain the historical bytes per relationship.

## 14. Candidate Optimizations — Design Ideas Only

No candidate below was implemented.

- Validate whether the current `facet_index` and its prefix index are needed
  by a production route; they consume 44.16 MB together.
- Separate catalogue membership from the 5.33M relationship scan so property
  definitions need not take 2.61 s.
- Evaluate narrower identity/dictionary representations for category, family,
  type and render/source/logical IDs while preserving exact returned strings.
- Review reverse-index coverage using measured value/match workloads; preserve
  query results and counts, not a specific B-tree layout.
- Define explicit raw-value equality/canonicalization rules before changing
  JSON value storage.
- Retain type-level storage and prevent any instance rematerialization.
- Keep immutable source metadata separately from bootstrap and query storage.

## 15. Recommended Scope for Sprint 007

### Requirement A — Preserve semantic equivalence

**Current evidence:** v1 and v2 contain identical semantic row counts while
v2 is 91.69% smaller.  
**Target characteristic:** Any vNext representation must return identical
element properties, definitions, distinct values/counts, matches and facets
for the same source package.

### Requirement B — Bound relationship-key cost

**Current evidence:** v1 property relationships consumed 61.20%; current v2
still spends 42.81% on 5.33M links plus reverse index.  
**Target characteristic:** Cost scales with compact relationship cardinality,
not source identifier/hash length.

### Requirement C — Remove proven redundant physical projections

**Current evidence:** historical definition/value duplication was 71.36 MB;
current facet structures consume 44.16 MB but are not used by production
routes.  
**Target characteristic:** Every materialized table/index has a named current
query or integrity responsibility and a measured benefit.

### Requirement D — Improve catalogue latency

**Current evidence:** 4,104 definitions require a median 2.61 s because the
query traverses 5.33M links.  
**Target characteristic:** Catalogue cost should depend primarily on
definition/scope cardinality while preserving the same API contract.

### Requirement E — Establish a repeatable parity benchmark

**Current evidence:** Store queries outperform IFC JSON scans, but one Type
facet path currently fails and memory peaks are dominated by full JSON parse.
  
**Target characteristic:** Golden Revit/IFC fixtures verify exact result parity,
DB size, build memory/time and cold/warm query latency before choosing SQLite
schema, dictionary, normalized, binary/columnar or other implementation.

Sprint 007 should choose architecture only after evaluating these measured
requirements. A smaller file is not acceptable if any Source Contract v1.1
information or Canonical Query API semantic is lost.

