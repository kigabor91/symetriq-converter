# R1 – E57 Conversion Integrity Audit

**Repository:** `symetriq-converter`  
**Scope:** audit and read-only instrumentation only  
**Classification:** **A. NO CONVERSION BUG** for the audited large fixture

## Scope and tested artifact

The audited production fixture is:

| Item | Value |
|---|---:|
| E57 path | `data/projects/d0a097d6-1454-4dba-9255-4d4ab6b4effe/uploads/910cb84a-93d5-45be-9c9a-e2c1b9308a5c.e57` |
| File size | 2,941,350,912 bytes (2.74 GiB) |
| Project scene origin | `[631566.8643907084, 240148.75360863237, 172.948]` metres |
| FAST LAS | 51,623,747 bytes |
| VERY FAST LAS | 32,282,113 bytes |
| Audit voxel size | 5 m |

This is the available large E57 plus its existing derived LAS output. The exact
shell command used for the separately reported approximately 2.3 GB manual
conversion was not present in repository history, therefore that invocation
cannot be independently reconstructed. The normal Hub path and the direct
worker path are compared below.

The available FAST and VERY FAST LAS artifacts are dated 2026-07-27, while the
LAS offset/int32 hotfix (`5163f9b`) was introduced on 2026-09-17. Consequently,
the binary-output comparison validates the historical conversion result and
the sampling path, rather than claiming that this 2.74 GiB file was fully
reconverted during this audit. The current-code conclusion for this local
fixture is still code-backed: the hotfix leaves the sampler unchanged,
`choose_las_offsets()` returns `[0, 0, 0]` for these bounds, and its zero-offset
encoding formula is the same millimetre encoding used by the existing output.
The new non-zero-offset branch is covered by `src/e57_worker_test.py`.

## Current production data path

```text
E57 upload
  → /api/projects/:projectId/files
  → queueE57Conversion() in src/server.ts
  → project sceneOrigin read once
  → convertE57(input, outputDirectory, fileId, sceneOrigin)
  → Python src/e57_worker.py
  → read_scan(transform=True)
  → subtract scene origin
  → deterministic spatial hash selection
  → LAS 1.2 point-format 2 output + panorama JPEG/station JSON
```

`src/convertE57.ts` starts `python src/e57_worker.py <input> <output> <fileId>`
and appends `--scene-origin X Y Z` only when the project has one. The server
updates the project as ready only after the worker exits with valid JSON.

The worker creates raw `.las` files directly. There is no LAS→LAZ compression
step in the structured E57 pipeline and the Viewer is given the FAST or VERY
FAST LAS URL directly.

### Point-affecting operations in current HEAD

| Stage | Behaviour | Point effect |
|---|---|---|
| Scan enumeration | `e57.get_header()` for every Data3D entry | Header-point-count zero scans are skipped intentionally |
| Read | `read_scan(..., transform=True, ignore_missing_fields=True)` | Scan pose is applied; fixture returned every declared point |
| Scene alignment | `coordinates - sceneOrigin` | Translation only; no filtering |
| Sampling | `spatial_sample()` hash of millimetre XYZ | FAST keeps about 1/50, VERY FAST about 1/80 |
| LAS writing | One record is emitted to each matching LOD | No cap, deduplication, chunk cap or per-scan limit |
| Panorama | `images2D` records are handled separately | Does not affect point records |

No other current code path filters, caps, rejects, deduplicates or replaces
E57 point records. The fixture had no non-finite or unreadable records after
`read_scan`.

## Thinning history

Git history contains no separately identifiable "spatial-loss" fix commit.
The current millimetre-coordinate hash sampler was already present in the
initial E57 implementation (`c1d412a Add IFC E57 conversion pipeline and
production API`) and remains present in current HEAD. No later commit bypasses
or replaces it.

The reported earlier issue cannot therefore be tied confidently to a distinct
repository revision. The current algorithm is not stride-, scanline-,
chunk-order- or global-count-based:

```python
hashed = (round(x * 1000) * 73856093) ^ ...
keep = (hashed & 0x7fffffff) % divisor == 0
```

For structured scans, this is spatially safer than every-Nth-record sampling:
input ordering cannot by itself remove a scanline or angular sector.

## Manual path versus normal Hub path

The direct diagnostic command documented previously invokes the same Python
worker as `convertE57.ts`. It is equivalent to the normal point conversion
only when all four values match:

1. input E57;
2. output directory;
3. file ID; and
4. `--scene-origin` values.

The normal Hub pipeline supplies the project `sceneOrigin`; a manual command
without it deliberately produces a different coordinate frame, but not a
different point set, scale or thinning algorithm. Node cancellation and project
status updates are the only additional normal-path behaviour. Both paths use
`SCALE = 0.001`, the same FAST/VERY FAST divisors and the same panorama code.

For the audited output, the project scene origin above is proven to be the one
used: transformed E57 bounds minus that origin agree with decoded LAS bounds.

## Source inventory

| Metric | Result |
|---|---:|
| Data3D entries / scans | 214 |
| Empty header scans | 1 (scan 0, declared point count 0) |
| Non-empty scans | 213 |
| Declared points | 99,395,046 |
| Valid points returned by `read_scan` | 99,395,046 |
| Invalid / unreadable points | 0 |
| Scans with RGB | 213 |
| Minimum points in a non-empty scan | 145,238 |
| Maximum points in a scan | 658,729 |
| Median points per non-empty scan | 616,714 |
| Local X/Y/Z minimum | `[-118.772704, -318.990738, -1.851695]` m |
| Local X/Y/Z maximum | `[163.353882, 0.107416, 20.152499]` m |

The output contains 214 panorama station directories and 1,284 JPEG faces
(six faces per station). This is independent of the intentionally empty point
scan.

## Point-count accounting

| Stage | FAST | VERY FAST |
|---|---:|---:|
| Valid E57 source points | 99,395,046 | 99,395,046 |
| Intentional sampling rule | coordinate hash `% 50 == 0` | coordinate hash `% 80 == 0` |
| Expected selected points | 1,985,520 | 1,241,611 |
| LAS header point count | 1,985,520 | 1,241,611 |
| Decoded LAS record count | 1,985,520 | 1,241,611 |
| Expected versus actual delta | 0 | 0 |
| Effective retention | 1.9976% | 1.2492% |

No points are silently dropped after the intentional sampling stage. The
sampling ratio per non-empty scan is stable:

| LOD | Lowest retention | Highest retention | Scans with zero selected points |
|---|---:|---:|---:|
| FAST | 1.8991% | 2.0845% | 0 |
| VERY FAST | 1.1914% | 1.3060% | 0 |

LAS point records do not include a scan identifier, so a literal per-scan LAS
record count is not recoverable after aggregation. Instead, the audit computes
the exact current selection independently for each scan, verifies its global
count against LAS, and verifies each scan's selected spatial cells against the
decoded LAS cells. Every non-empty scan had selected points and zero missing
expected occupied cells in both LOD outputs.

## Spatial coverage

The read-only audit performs two E57 passes, each holding only one scan array:

1. transformed, scene-local source bounds;
2. exact current hash selection and occupied 5 m cells.

It then decodes all LAS records independently and compares occupied cells.

| Comparison | Expected cells | Actual LAS cells | Missing | Unexpected | Coverage |
|---|---:|---:|---:|---:|---:|
| FAST selected source → FAST LAS | 5,769 | 5,769 | 0 | 0 | 100% |
| VERY FAST selected source → VERY FAST LAS | 5,762 | 5,762 | 0 | 0 | 100% |
| Full source → FAST LAS | 5,802 | 5,769 | 33 | 0 | 99.431% |
| Full source → VERY FAST LAS | 5,802 | 5,762 | 40 | 0 | 99.311% |

The small difference against the *full* source is the expected consequence of
sampling cells with few source points. It is not a contiguous missing spatial
region: every occupied cell selected by the current sampler exists in the LAS.
This rules out the suspected scan/chunk/region-loss behaviour for this fixture.

## Coordinate, offset and LAS-header validation

The coordinate formula in current HEAD is:

```text
local = transformedE57Coordinate - sceneOrigin
encoded = round((local - lasOffset) / 0.001)
decoded = encoded * 0.001 + lasOffset
```

For this fixture, local coordinates are already safely inside signed int32 at
1 mm precision, so `choose_las_offsets()` correctly selects `[0, 0, 0]`.
This is the intentional backward-compatible branch of commit `5163f9b`; the
new offset logic does not alter the coordinates for this local cloud.

Because the derived LAS predates that commit, the offset conclusion combines
the independently decoded historical LAS with the current worker's offset
selection for the same source bounds. A full current-code regeneration was not
performed as part of this read-only integrity audit.

| LAS field | FAST | VERY FAST |
|---|---|---|
| Version / point format | 1.2 / 2 (XYZ + RGB) | 1.2 / 2 (XYZ + RGB) |
| Record length | 26 bytes | 26 bytes |
| Scale | `[0.001, 0.001, 0.001]` m | `[0.001, 0.001, 0.001]` m |
| Offset | `[0, 0, 0]` m | `[0, 0, 0]` m |
| Header count = decoded count | yes | yes |
| Header bounds contain decoded records | yes | yes |

The header's bounds retain original floating source precision while records are
quantized to 1 mm. Their maximum observed difference is below 0.5 mm, which is
the expected quantization bound. The audit found no overflow, wrapping, double
scene-origin subtraction or remote-coordinate displacement.

## Viewer-independent validation

`tools/e57_integrity_audit.py` parses binary LAS headers and fixed-size records
without using xeokit or the Hub Viewer. It independently validates record count,
decoded coordinates, bounds, scale, offsets and 3D occupancy. Therefore the
positive result is not dependent on the Viewer rendering path.

## Memory and scalability observation

Neither the worker nor the audit retains the entire 99.4 million-point cloud.
Both operate scan by scan; the largest scan has 658,729 points. The current
worker does make two E57 passes after the offset fix (bounds, then output), and
each `read_scan` materialises one scan. This is a scalability consideration,
but not a point-integrity defect in the audited fixture.

## Conclusion and follow-up

**Classification A — no conversion bug** is supported for the audited large
fixture. The source, exact selected samples and decoded LAS spatial coverage
agree. The recent LAS-offset fix did not regress this local-coordinate case.

The observed visual incompleteness is therefore most plausibly the intended
roughly 2% FAST density / Viewer rendering or LOD presentation, not point loss.
No production conversion fix is recommended from this audit.

If the separately manually converted approximately 2.3 GB input still appears
incomplete, the only justified follow-up is to run the same read-only command
against that exact E57, its FAST and VERY FAST outputs, with the exact project
scene origin. A Viewer-only reproduction can then be investigated separately
if this comparison also reaches 100% selected-cell coverage.

## Reproduction

```powershell
python .\tools\e57_integrity_audit.py `
  "<input.e57>" `
  "<fileId>.fast.las" `
  "<fileId>.very-fast.las" `
  --scene-origin <x> <y> <z> `
  --output "data\e57-integrity-audit.json"
```

The generated JSON is intentionally stored below `data/`, which is ignored by
Git. The audit utility is read-only with respect to the E57 and LAS inputs.
