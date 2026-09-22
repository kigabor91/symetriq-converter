# R2 – Resumable Large File Upload Architecture & Contract

**Repository:** `symetriq-converter`  
**Sprint type:** architecture, contract and benchmark design only  
**Status:** **PASS – implementation intentionally deferred**

## 1. Executive decision

SymetrIQ should introduce a **generic, project-bound resumable upload service**.
It must not be E57-specific. E57 remains one consumer of a completed project
asset, while the transport can also serve IFC, LAS/LAZ and later other
allow-listed large asset types.

The selected first implementation is:

- server-selected **64 MiB** parts;
- browser default **two concurrent part requests**;
- raw `application/octet-stream` part bodies created with `File.slice()`;
- persistent session manifests plus **separate immutable part files**;
- server-computed SHA-256 for every part and the finalized file;
- optional producer-supplied expected part and final SHA-256 values;
- asynchronous, restart-recoverable finalization;
- atomic handoff into the existing project file model;
- a 72-hour inactivity expiry for incomplete sessions.

No individual request needs to approach 2 GB. A normal request-filter and proxy
budget slightly above 64 MiB is sufficient.

## 2. Existing upload architecture and failure motivation

### 2.1 Current production path

The current implementation is:

```text
Viewer ProjectService.uploadProjectFiles()
  → fetch(FormData)
  → IIS URL Rewrite / ARR
  → POST /api/projects/:projectId/files
  → trackUpload()
  → Multer diskStorage
  → data/upload-temp/<random temporary file>
  → rename to data/projects/<projectId>/uploads/<fileId>.<extension>
  → append ProjectFileRecord to data/projects.json
  → queueIfcConversion() / queueE57Conversion(), or mark LAS/LAZ ready
```

Relevant current code:

- `symetriq-viewer/viewer/src/services/ProjectService.ts` creates one
  `FormData` request containing every selected file;
- `src/server.ts` configures Multer `diskStorage`, a 20 GiB per-file limit and
  a 30-minute Node request timeout;
- `src/server.ts` registers the completed source under the project's existing
  `uploads` directory and starts conversion only after Multer has completed;
- `src/projectStore.ts` persists the canonical `ProjectFileRecord` list through
  atomic temporary-file replacement of `data/projects.json`;
- `symetriq-viewer/deployment/iis/web.config` currently allows a nearly 4 GiB
  request and proxies `/api` to Node.

The current route does stream to disk and does not buffer the complete file in
Node memory. It also correctly prevents conversion from reading a partial
Multer file. Those properties should be preserved.

### 2.2 Proven transport failure

One production request declared 2,392,272,089 bytes but stopped at exactly
2,147,483,647 bytes. The repository contains no intentional client abort,
signed-int byte counter or Multer limit at that boundary. R1 separately proved
that E57 conversion is not the cause. The remaining architectural issue is the
single, long-lived multi-gigabyte HTTP request across browser, IIS/ARR and
Node.

R2 deliberately does not further patch that request. Chunking removes the
multi-gigabyte request as a dependency and makes each failed unit retryable.

## 3. Boundaries and invariants

The design separates three durable concepts:

```text
Upload session
  owns temporary verified parts and upload progress
        ↓ complete + integrity validation
Final project asset
  owns one byte-identical source file and ProjectFileRecord
        ↓ durable processing handoff
Processing
  owns E57/IFC conversion state and derived output
```

Invariants:

1. Part data is never visible as a project asset.
2. Processing never starts from an upload-session path.
3. A project record is created only after a complete source has been assembled
   and validated.
4. The final source file is byte-identical to the ordered uploaded parts.
5. Upload completion does not imply processing completion.
6. Retrying a request cannot create a second project file or corrupt a part.
7. The public contract contains no E57 conversion semantics.

## 4. Generic versus E57-specific decision

The upload subsystem is **generic**. Its responsibilities are byte transport,
durable state, integrity, lifecycle and final asset handoff. A small registry
maps allowed `fileKind` plus extension to the existing project-file adapter.

Initial allow-list:

| API `fileKind` | Extensions | Existing project kind | Post-finalization action |
|---|---|---|---|
| `structured-e57` | `.e57` | `structured-e57` | durable queued record, then E57 dispatch |
| `ifc` | `.ifc` | `ifc` | durable queued record, then IFC dispatch |
| `point-cloud` | `.las`, `.laz` | `point-cloud` | register ready source/package |

RVT, ZIP and document packages can use the transport later only after their
own project-asset adapter and authorization policy exist. Accepting arbitrary
bytes without a permanent asset model is explicitly out of scope.

## 5. Canonical API contract

All timestamps are UTC ISO-8601. Byte counts are non-negative JSON integers
within `Number.MAX_SAFE_INTEGER`; the configured product limit remains lower.
Part numbering is zero-based. SHA-256 values are lowercase hexadecimal.

### 5.1 Create a session

```http
POST /api/projects/{projectId}/uploads
Content-Type: application/json
Idempotency-Key: <client-generated UUID, optional but recommended>
```

```json
{
  "filename": "survey.e57",
  "mimeType": "application/octet-stream",
  "fileKind": "structured-e57",
  "totalBytes": 2941350912,
  "expectedSha256": "optional-64-character-hex",
  "operation": "create",
  "replaceFileId": null
}
```

`operation` is `create` initially. `replace` is reserved for the same verified
transport and requires a matching existing `replaceFileId`; it is delivered in
the integration stage, not silently emulated as delete-then-upload.

Successful response:

```http
201 Created
Location: /api/uploads/4e6...f91
```

```json
{
  "uploadId": "4e6...f91",
  "projectId": "project-id",
  "status": "created",
  "chunkSize": 67108864,
  "totalBytes": 2941350912,
  "totalParts": 44,
  "receivedBytes": 0,
  "uploadedParts": [],
  "createdAt": "2026-09-22T10:00:00.000Z",
  "updatedAt": "2026-09-22T10:00:00.000Z",
  "expiresAt": "2026-09-25T10:00:00.000Z"
}
```

The server is authoritative for `chunkSize`, `totalParts`, the normalized
filename/extension and the accepted `fileKind`. A repeated create request with
the same authenticated owner and `Idempotency-Key` returns the original
session instead of allocating another multi-gigabyte upload.

### 5.2 Upload a part

```http
PUT /api/uploads/{uploadId}/parts/{partNumber}
Content-Type: application/octet-stream
Content-Length: <exact expected part length>
X-Part-SHA256: <optional expected hash>

<raw Blob.slice() bytes>
```

The expected length is `chunkSize` except for the final part, whose exact size
is derived from `totalBytes`. Multipart encoding is not used for parts.

New part response:

```http
201 Created
```

```json
{
  "uploadId": "4e6...f91",
  "partNumber": 17,
  "size": 67108864,
  "sha256": "server-computed-hash",
  "alreadyPresent": false,
  "receivedBytes": 1207959552,
  "status": "uploading"
}
```

An identical replay returns `200 OK` with `alreadyPresent: true`. A replay with
a different size or hash returns `409 PART_CONFLICT`; the accepted part remains
untouched. The request is first streamed to a unique `.incoming` file, hashed
while writing, then atomically renamed to the canonical part name. A failed or
conflicting incoming file is deleted.

### 5.3 Inspect and resume

```http
GET /api/uploads/{uploadId}
```

```json
{
  "uploadId": "4e6...f91",
  "projectId": "project-id",
  "filename": "survey.e57",
  "fileKind": "structured-e57",
  "status": "uploading",
  "chunkSize": 67108864,
  "totalBytes": 2941350912,
  "totalParts": 44,
  "receivedBytes": 1207959552,
  "uploadedParts": [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  "createdAt": "2026-09-22T10:00:00.000Z",
  "updatedAt": "2026-09-22T10:08:00.000Z",
  "expiresAt": "2026-09-25T10:08:00.000Z",
  "error": null,
  "finalAsset": null
}
```

`uploadedParts` lists only durably closed and manifest-confirmed parts. With a
64 MiB part size this is 32 entries for 2 GiB, 160 for 10 GiB and 800 for
50 GiB, so a sorted integer array is simpler and still small. Range encoding
is deferred until a real scale requires it.

### 5.4 Complete

```http
POST /api/uploads/{uploadId}/complete
Content-Type: application/json
```

```json
{
  "expectedSha256": "optional-if-not-supplied-at-create"
}
```

If any part is missing, the server returns `409 UPLOAD_INCOMPLETE` with the
missing part numbers. Otherwise it atomically changes the durable status to
`finalizing` and returns `202 Accepted`. Finalization is not tied to the
lifetime of this HTTP request.

Repeated completion is idempotent:

- `finalizing` → `202` with the same status;
- `complete` → `200` with the same `finalAsset` and final hash;
- recoverable `failed` → a documented retry may resume/restart finalization;
- integrity mismatch → terminal `422 INTEGRITY_MISMATCH`; start a new session
  or replace the incorrect part before completion if no assembly was exposed.

Completed status includes:

```json
{
  "status": "complete",
  "receivedBytes": 2941350912,
  "finalSha256": "server-computed-hash",
  "finalAsset": {
    "projectId": "project-id",
    "fileId": "reserved-project-file-id",
    "revision": 1,
    "status": "queued"
  }
}
```

### 5.5 Cancel

```http
DELETE /api/uploads/{uploadId}
```

Before project registration this marks the session `cancelled`, prevents new
parts/finalization and removes temporary bytes asynchronously. During
finalization it sets `cancelRequested`; the finalizer checks it before asset
registration. After `complete`, this endpoint never deletes the project asset;
the existing project-file deletion API remains authoritative.

### 5.6 Error contract

Errors have stable machine codes:

```json
{
  "error": {
    "code": "PART_LENGTH_MISMATCH",
    "message": "Part 17 must contain 67108864 bytes.",
    "requestId": "request-id",
    "retryable": false
  }
}
```

Important statuses include `400 INVALID_REQUEST`, `403 FORBIDDEN`,
`404 UPLOAD_NOT_FOUND`, `409 PART_CONFLICT`, `409 UPLOAD_INCOMPLETE`,
`410 UPLOAD_EXPIRED`, `413 PART_TOO_LARGE`, `422 INTEGRITY_MISMATCH`,
`429 TOO_MANY_ACTIVE_UPLOADS` and retryable `5xx` storage failures.

## 6. Durable state machine

```text
created ──first accepted part──► uploading
   │                                │
   ├──────── DELETE ───────────────► cancelled
   │                                │
   └──────── inactivity ───────────► expired

uploading ──all parts + complete──► finalizing
   │                                  │
   ├── DELETE ───────────────────────► cancelled
   ├── inactivity ───────────────────► expired
   │                                  ├── validation/storage error ─► failed
   │                                  └── asset registration ───────► complete
   │
   └── more/replayed parts ─────────► uploading

failed ──retryable complete────────► finalizing
complete ──processing handoff──────► ProjectFileRecord queued/ready
```

Statuses belong to the upload session only. E57 `queued`, `processing`,
`ready`, `error` and `cancelled` remain project-processing states and are not
folded into this state machine.

## 7. Chunk-size evaluation

| Part size | 2 GiB | 10 GiB | 50 GiB | Retry cost | Assessment |
|---:|---:|---:|---:|---|---|
| 32 MiB | 64 | 320 | 1,600 | lowest | more HTTP/manifest overhead; useful on poor links |
| **64 MiB** | **32** | **160** | **800** | low | selected balance |
| 128 MiB | 16 | 80 | 400 | medium | longer proxy request and retry |
| 256 MiB | 8 | 40 | 200 | high | unnecessarily expensive failures |

**64 MiB is the default.** It is comfortably below IIS's 2/4 GiB classes,
large enough that headers and manifest writes are negligible on LAN, and
small enough that a failed WAN request is affordable. It maps cleanly to both
S3 multipart and Azure block concepts. The server may later select a different
allowed size; clients must never hardcode it.

The last part may be smaller. Zero-byte files are rejected for current project
asset kinds. A server-side maximum part size (initially 64 MiB plus no encoding
overhead because the body is raw) protects against oversized requests.

## 8. Browser client model

The browser keeps the original `File` handle and never creates a whole-file
`ArrayBuffer`:

```text
create session
  → GET/reconcile uploadedParts if resuming
  → for each missing part:
       start = partNumber * serverChunkSize
       end = min(start + serverChunkSize, file.size)
       blob = file.slice(start, end)
       PUT raw blob
  → complete
  → poll GET while finalizing
  → display project processing state separately
```

Use `XMLHttpRequest` for each Blob request in the first Viewer implementation,
because it supplies native upload-progress events without copying the whole
file. `fetch(Blob)` remains possible when only confirmed-part progress is
needed. Cancellation aborts active requests and calls `DELETE` once.

Client resume data should persist only non-sensitive identifiers and local-file
fingerprint hints (`name`, `size`, `lastModified`), not file bytes. After page
reload the user reselects the file; the client verifies these hints and, where
available, the expected final hash before resuming the server session.

### Retry policy

- retry network errors, 408, 429 and retryable 5xx;
- exponential backoff with jitter, for example 1 s, 2 s, 4 s, 8 s, capped at
  30 s and five automatic attempts per part;
- honor `Retry-After`;
- do not retry validation, authorization, conflict or integrity errors blindly;
- after ambiguous response loss, query session state or safely replay the part.

Displayed progress has two values: confirmed bytes from the server and
in-flight bytes from active XHR events. Only confirmed bytes survive reload.
Finalization and conversion receive distinct UI phases.

## 9. Concurrency decision

| Mode | Benefit | Cost / risk | Decision |
|---|---|---|---|
| Sequential | simplest, lowest disk pressure | underuses higher-latency links | supported configuration |
| **2 concurrent** | hides latency, conservative disk/network use | two temporary incoming streams | selected default |
| 3 concurrent | sometimes faster on WAN | more disk seeks and retry traffic | optional after measurement |
| 4+ concurrent | local benchmark potential | proxy/browser pressure, little LAN benefit | not default |

Default concurrency is **2**, configurable between 1 and 4. The server must
also enforce per-session and per-user/project concurrency limits. Multiple
requests for the same part are safe but do not count as useful concurrency.

## 10. Temporary storage alternatives

### Option A – separate immutable part files (selected)

```text
data/upload-sessions/<uploadId>/
  session.json
  parts/
    00000000.part
    00000001.part
  incoming/
    <requestId>.tmp
  assembled.tmp
```

Advantages:

- a closed part is an obvious crash-recovery unit;
- retries and conflicts do not overwrite confirmed bytes;
- concurrent writes target separate files;
- per-part length/hash validation is natural;
- maps directly to cloud multipart/block upload;
- no sparse-file or random-write platform differences.

Costs:

- local finalization must sequentially assemble the source;
- peak disk use is approximately two times source size during assembly;
- many files are created (800 for 50 GiB at the selected size).

The file count is modest for expected sessions. Before accepting a session,
the server should require capacity for parts plus assembled output and a safety
reserve. Parts are deleted after the project source is durably registered.

### Option B – one pre-sized random-access file (deferred)

This saves the assembly copy and reduces peak disk use, but requires safe
range locking, durable per-range metadata, handling sparse/preallocated files,
careful concurrent writes and a full-file read for final hashing anyway. It is
a valid future local-storage optimization only if finalization I/O is measured
as a bottleneck. It is not the safest first resumable implementation.

## 11. Persistent session representation

`session.json` is the local authoritative metadata and is written as
`session.json.tmp` followed by atomic rename, matching the existing project
store pattern. It contains no client-supplied path:

```ts
interface UploadSessionRecord {
  version: 1;
  uploadId: string;
  projectId: string;
  ownerId?: string;
  idempotencyKey?: string;
  filename: string;
  normalizedExtension: string;
  mimeType: string;
  fileKind: "structured-e57" | "ifc" | "point-cloud";
  operation: "create" | "replace";
  replaceFileId?: string;
  reservedFileId: string;
  totalBytes: number;
  chunkSize: number;
  totalParts: number;
  receivedBytes: number;
  expectedSha256?: string;
  finalSha256?: string;
  status: "created" | "uploading" | "finalizing" | "complete" |
          "failed" | "cancelled" | "expired";
  parts: Array<{ partNumber: number; size: number; sha256: string }>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  leaseUntil?: string;
  cancelRequested?: boolean;
  finalAsset?: { projectId: string; fileId: string; revision: number };
  error?: { code: string; message: string; retryable: boolean };
}
```

The manifest is the source of confirmed progress; directory contents alone are
not. On startup a reconciler may adopt a canonical part only when its size and
hash match the manifest, and deletes stale `.incoming` files after their lease.

The local v1 design assumes the existing single Node service. A per-session
mutex serializes manifest mutation and finalization, while different parts may
stream concurrently. Horizontal Node scaling later requires shared state and
distributed locking or object-storage-native multipart state; this is not
hidden behind unsafe local assumptions.

## 12. Integrity strategy

### During part receipt

1. Validate session state, ownership, part number and expected exact length.
2. Require a valid bounded `Content-Length`; reject chunked/unknown-length part
   requests in local v1.
3. Stream into a unique incoming file while counting bytes and computing
   SHA-256; never buffer the part in Node RAM.
4. Compare actual bytes to header and contract-derived length.
5. If `X-Part-SHA256` exists, compare it with the computed hash.
6. Atomically promote the incoming file, then atomically record its metadata.

### During finalization

1. Revalidate every manifest entry and canonical part size.
2. Concatenate parts in exact numeric order through bounded streams.
3. Compute final SHA-256 during assembly.
4. Verify exact final byte count.
5. Compare optional producer `expectedSha256`.
6. Flush/close the assembled file before project registration.

The server always records and returns the final SHA-256 even when the producer
did not know it beforehand. TLS protects transport; server part hashes protect
stored-part identity and idempotency; a producer-supplied final hash provides
true end-to-end producer-to-Hub verification.

## 13. Idempotency and concurrency safety

- Create: `Idempotency-Key` maps a repeated request to one session.
- Part: canonical identity is `(uploadId, partNumber, size, sha256)`. Same bytes
  return success; different bytes return conflict without replacement.
- Complete: the reserved `fileId` is created with the session and reused by
  every attempt. A repeated complete cannot create a second project record.
- Manifest updates: per-session lock plus atomic replace prevents lost updates.
- Finalization: only one finalizer owns the session lease. Another caller gets
  the durable current state.
- Project registration: update by reserved `fileId`, not append blindly.

Part hash metadata is retained with the completed session for its retention
window, allowing late ambiguous retries to be answered deterministically even
after physical part cleanup.

## 14. Finalization and atomic project-file integration

Exact sequence:

1. `complete` verifies all part numbers and persists `finalizing`.
2. The upload finalizer builds `assembled.tmp`, validates size and hash.
3. It chooses the destination only from server-owned IDs:
   `data/projects/<projectId>/uploads/<reservedFileId>.<extension>`.
4. It atomically renames the verified staging file to that destination on the
   same data volume.
5. It idempotently adds/updates the existing `ProjectFileRecord` in
   `data/projects.json` using `writeProjects()` atomic replacement.
6. It persists the upload session as `complete` with `finalAsset`.
7. Only then does the processing dispatcher inspect the project record.
8. It deletes part bytes after the source and both durable records reconcile.

Filesystem rename, `projects.json` update and `session.json` update cannot form
one OS transaction. The reserved `fileId` makes every intermediate state
recoverable:

| Crash point | Recovery action |
|---|---|
| before destination rename | discard/reuse `assembled.tmp`, re-finalize |
| after destination rename, before project record | validate destination hash, register same `fileId` |
| after project record, before session complete | reconcile record/file, mark session complete |
| after session complete, before dispatch | durable queued project record is dispatched on startup |

No project record is published before the verified source exists. A stale
source without a record is not reachable through `/project-files` URLs and is
reconciled by session ID/file ID.

### Existing project model

The new subsystem terminates in the current structures; it does not create a
parallel permanent store:

- original source remains in the current project `uploads` directory;
- metadata remains a normal `ProjectFileRecord` in `projects.json`;
- LAS/LAZ packages continue to use `buildPointCloudPackage()`;
- E57 and IFC continue to use their existing queue functions after handoff;
- retry/delete APIs continue to operate on the finalized original upload.

Replacement uses the same verified source but requires a guarded revision
update. The existing asset must remain active until the replacement has passed
final integrity validation. The implementation must not call
`removeStoredFileAssets()` at session creation or during part upload.

## 15. E57 integration

```text
verified upload session
  → one finalized <fileId>.e57 in project uploads
  → ProjectFileRecord(kind=structured-e57, status=queued)
  → upload session complete
  → queueE57Conversion(projectId, fileId, finalizedPath, revision)
```

No E57 scan is read per part. No conversion algorithm, scene-origin logic,
panorama extraction or LAS sampling changes. The worker always receives one
byte-identical finalized E57 source.

## 16. Cleanup and expiration

Recommended initial policy:

- `created`, `uploading`: expire after **72 hours without accepted activity**;
- `failed` with retryable storage error: retain parts up to 24 hours, bounded
  by the same absolute/session quota;
- integrity failure: retain metadata for diagnosis but remove bytes after 24
  hours unless explicitly retried with corrected parts;
- `cancelled`, `expired`: stop acceptance immediately; remove temporary bytes
  promptly and retain a small tombstone for 24 hours;
- `complete`: remove parts after reconciliation; retain session metadata and
  hashes for seven days for idempotent status/complete responses;
- stale incoming files: remove after their owning request lease is expired.

Every PUT/finalizer obtains a persisted `leaseUntil` before writing. Cleanup
skips sessions with an unexpired lease and also respects the in-process mutex.
Cleanup first changes state durably to `expired`, then deletes bytes, so a race
cannot revive the session. Failures are retried and logged with reclaimed byte
counts. Per-project/user active-byte quotas prevent abandoned sessions from
exhausting the volume before expiry.

## 17. Server restart recovery

At startup the upload service scans `data/upload-sessions/*/session.json`:

- `created`/`uploading`: remove stale incoming files, verify manifest-declared
  parts exist, correct only safely derivable counters, and allow resume;
- `finalizing`: acquire the session lease and restart deterministic assembly,
  or reconcile an already validated destination/project record;
- `complete`: verify the final asset reference exists; clean leftover parts;
- `cancelled`/`expired`: continue cleanup;
- corrupt manifest: quarantine the session, never infer a complete asset from
  untrusted directory contents, and report a stable failed status.

A process dying mid-part leaves only a unique incoming file, never a confirmed
part. A process dying mid-assembly leaves `assembled.tmp`, never a project
asset. The next finalizer can validate and reuse or safely recreate it.

The finalized `ProjectFileRecord(status=queued)` is the durable handoff marker.
Startup dispatch must idempotently resume queued IFC/E57 processing so a crash
between upload completion and in-process queue invocation does not strand the
asset. This is handoff recovery, not a general async job-queue redesign.

## 18. Security and validation hooks

Authentication is not redesigned, but every operation must have hooks for:

- project authorization at session creation and every later session request;
- immutable session owner/project association;
- total file size, active session and aggregate temporary-byte quotas;
- server allow-listed extension/file-kind pairs;
- optional content-signature validation before project registration;
- basename-only display filename, length/control-character normalization;
- server-generated upload, part, staging and final filesystem paths;
- integer/bounds validation of part numbers and exact last-part length;
- bounded `Content-Length` and early rejection of oversized bodies;
- strict SHA-256 syntax and constant semantic comparison;
- per-session concurrency/rate limits and duplicate-create idempotency;
- no trust in MIME type, client filesystem paths or supplied project paths;
- audit logging of owner, project, upload ID, request ID, byte counts and state
  transitions without logging file contents.

Path containment checks must resolve beneath the expected data/session or
project root before any rename/delete. Symlinks/reparse-point surprises should
not be followed by cleanup/finalization code.

## 19. IIS / ARR compatibility

The selected protocol requires only bounded 64 MiB raw PUT bodies and small
JSON requests. It does **not** require:

- request bodies over 2 GB;
- the current 4 GiB IIS request-filter value;
- an infinite ARR or Node timeout;
- keeping one connection alive for the entire file.

Normal production configuration still needs:

- URL Rewrite/ARR proxying the new `/api/uploads` and project upload routes;
- PUT and DELETE verbs allowed;
- `maxAllowedContentLength` somewhat above 64 MiB (for example 80 MiB; a
  conservative 128 MiB ceiling is also reasonable);
- a finite per-request proxy/Node timeout long enough for one part on the
  slowest supported link (initial recommendation: five minutes);
- request streaming and sufficient local temp-disk permissions;
- TLS and normal request logging.

The existing 4 GiB setting can remain during rollout for legacy endpoints but
is no longer required by resumable upload. It may be reduced after all large
asset clients use the new contract.

## 20. Performance characteristics and benchmark plan

Observed legacy active transfer was approximately 68 MB/s before abort. R2 is
not a throughput-maximization exercise. Initial targets are:

| Metric | Target / expectation |
|---|---|
| LAN upload throughput | at least 85–95% of stable legacy throughput, about 58–65 MB/s on the observed host |
| WAN utilization | at least 80% of available link where latency allows concurrency 2 |
| Node memory | bounded by stream buffers and active requests, independent of total file size; target under 64 MiB incremental RSS at concurrency 2 |
| Browser memory | Blob handles/XHR buffers only; no whole-file allocation |
| Upload disk writes | approximately one source size across part files |
| Finalization disk I/O | one sequential read plus one sequential write, plus hashing |
| Peak temporary disk | up to approximately two source sizes plus safety reserve during local assembly |
| HTTP overhead | 32 requests/2 GiB, 160/10 GiB, 800/50 GiB at 64 MiB |

At 68 MB/s a 64 MiB request is roughly one second on the measured LAN. On a
1 MiB/s link it is roughly 64 seconds, still within a normal finite proxy
budget and cheap to retry compared with a whole file.

Implementation benchmarking must record small and multi-gigabyte logical/real
fixtures, concurrency 1/2/3, end-to-end throughput, retry waste, Node peak RSS,
browser memory where measurable, disk bytes, finalization time and restart
recovery time. Sparse/synthetic files may test size arithmetic, but a byte-
identical multi-GB assembly test is required before production acceptance.

## 21. Future object-storage mapping

The public concepts intentionally map to cloud multipart primitives:

| SymetrIQ | S3-like | Azure-like |
|---|---|---|
| upload session | multipart upload ID | block-blob upload context |
| part number | part number | deterministic block ID |
| part SHA/receipt | checksum + ETag | block checksum/receipt |
| complete | CompleteMultipartUpload | Put Block List |
| cancel | AbortMultipartUpload | discard uncommitted blocks |

The Hub remains authoritative for project authorization, session state and the
final project record. A later storage adapter may return pre-signed part URLs
instead of proxying bytes through Node. The API's session/part/complete model
and Viewer resume logic need not become E57- or provider-specific.

## 22. Rejected and deferred alternatives

| Alternative | Classification | Reason |
|---|---|---|
| keep increasing single multipart limits/timeouts | Reject | retains all-or-nothing multi-GB failure and proxy dependency |
| E57-only chunk endpoints | Reject | duplicates byte transport for future large assets |
| whole-file browser `ArrayBuffer` | Reject | total-file-sized RAM and reserialization |
| process chunks as E57 fragments | Reject | E57 parser requires the finalized source and violates integrity boundary |
| random-access final-sized temp file | Defer | less I/O but materially more crash/range/platform complexity |
| 256 MiB default parts | Reject for v1 | expensive retries and unnecessarily long individual requests |
| concurrency 4+ by default | Reject for v1 | server/disk pressure without proven real-network gain |
| in-memory session state | Reject | cannot resume after restart |
| trust uploaded filename/path | Reject | traversal and asset-collision risk |
| require final client hash in every browser flow | Defer as mandatory | strong end-to-end check, but browser incremental hashing needs separate UX/library evaluation; server final hash is always computed |
| introduce async conversion job queue | Out of scope | upload finalization and processing are separate concerns |

## 23. Implementation test strategy

The implementation sprint must include:

1. small one-part and multi-part files;
2. size arithmetic beyond 2 GiB without allocating it in memory;
3. a practical multi-GB streaming/assembly integration fixture;
4. wrong/missing part and invalid part number;
5. duplicate identical part;
6. simultaneous identical part requests;
7. conflicting duplicate payload;
8. wrong normal and final-part length;
9. optional part-hash mismatch;
10. final size and final-hash mismatch;
11. interrupted body leaving no confirmed part;
12. resume from `uploadedParts`;
13. client retry/backoff and cancellation;
14. restart during part upload;
15. restart during every finalization checkpoint;
16. idempotent repeated complete;
17. cancellation and 72-hour expiry;
18. cleanup respecting an active lease;
19. failed disk write/finalization with retained recoverable parts;
20. byte-for-byte/hash-identical finalized output;
21. bounded Node/browser memory;
22. project record created exactly once;
23. no conversion before complete registration;
24. completed E57 follows the unchanged conversion path;
25. IFC/LAS/LAZ regression tests;
26. authorization/path traversal/oversized request validation;
27. IIS/ARR production smoke test with a file above 2 GiB.

Fault-injection tests should stop the service after durable checkpoints and
restart against the same data directory. Merely mocking the state machine is
not enough for restart/finalization acceptance.

## 24. Exact follow-up implementation plan

No stage below is implemented by R2.

### R2B.1 – Backend upload-session foundation

**Recommended model:** Terra Medium  
**Repository/components:**

- new `src/uploads/` domain types, validation, local paths and persistent store;
- thin routes wired from `src/server.ts`;
- configuration for limits, 64 MiB chunk size and expiry;
- tests for create/get, state persistence, path/size/file-kind validation and
  create idempotency.

**Dependencies:** none beyond current project/data-root helpers.  
**Acceptance:** sessions persist through restart; no byte endpoint or project
registration yet; API contract fields/errors match this document.

### R2B.2 – Part upload, integrity and resume

**Recommended model:** Sol Medium  
**Repository/components:**

- raw-body streaming part route (not Multer);
- per-session coordination, incoming/canonical part lifecycle;
- streaming SHA-256 and atomic manifest updates;
- GET progress/reconciliation and retry-safe duplicate handling;
- quotas, cancellation and bounded-memory tests.

**Dependencies:** R2B.1.  
**Acceptance:** interrupted/replayed/conflicting requests behave exactly as
contracted; confirmed progress resumes after Node restart; no project file or
conversion is created.

### R2B.3 – Finalization, integrity and recovery

**Recommended model:** Sol Medium  
**Repository/components:**

- persistent finalizer/reconciler under `src/uploads/`;
- ordered streaming assembly and final SHA-256;
- finalization leases, startup recovery and failure injection;
- cleanup/expiry service and disk-capacity diagnostics.

**Dependencies:** R2B.2.  
**Acceptance:** byte-identical output, idempotent complete, recovery at each
crash checkpoint, no partial output exposed, abandoned bytes reclaimed.

### R2B.4 – Viewer resumable uploader

**Recommended model:** Terra Medium  
**Repository:** `symetriq-viewer/viewer`  
**Components:** upload service, XHR Blob-part queue, progress/retry/cancel/resume
state, Project Details UI and client tests.

**Dependencies:** stable R2B.1–3 contract.  
**Acceptance:** no whole-file allocation; concurrency 2; accurate confirmed and
in-flight progress; refresh/reselection resumes missing parts; errors are
actionable; existing small upload UX remains usable during migration.

### R2B.5 – Project-file and E57 integration

**Recommended model:** Sol Medium  
**Repository/components:**

- shared project asset registration extracted from current `src/server.ts`;
- idempotent create and guarded replace using reserved `fileId`;
- durable queued handoff/startup dispatch for E57 and IFC;
- LAS/LAZ package registration;
- compatibility/regression tests for existing project retry/delete/replace.

**Dependencies:** R2B.3; Viewer can proceed in parallel after API stability.  
**Acceptance:** a completed E57 is registered once and uses the unchanged E57
converter; partial uploads never appear; restart cannot strand a queued asset;
existing project-file model and URLs remain canonical.

### R2B.6 – Cleanup, production configuration and validation

**Recommended model:** Terra Medium  
**Repositories/components:** backend operations, Viewer deployment IIS config,
metrics/logging and deployment documentation.

**Dependencies:** R2B.1–5.  
**Acceptance:** expiry/quotas work under production paths; PUT/DELETE and the
bounded IIS limit are validated; >2 GiB E57 upload resumes after forced network
and Node interruption; throughput/memory/finalization measurements meet agreed
targets; legacy large multipart dependence can be retired.

## 25. Follow-up scope guard

The implementation stages must not change:

- E57 coordinate, pose, thinning, panorama or LAS algorithms;
- IFC/Revit conversion semantics;
- Viewer rendering;
- Publish Package contract;
- public property/metadata contracts;
- authentication architecture beyond authorization hooks;
- object storage or pre-signed URL implementation;
- general-purpose processing/job queues.

The outcome is one robust transport subsystem feeding the already established
project asset and processing boundaries.
