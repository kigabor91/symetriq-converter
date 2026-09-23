# Preserved Store v2 compatibility fixture

`canonical-property-store.sqlite` and its manifest were built with the unmodified
`CanonicalPropertyStore.build()` compiled from commit
`b29aad229d0704543d4b3b0041334f3e6c92af13`, before the Store v3 changes.
The input is `source-metadata.json` in this directory. This is a genuine v2
artifact, not a v3 database relabelled as v2.

- Database: 102,400 bytes, SQLite `PRAGMA user_version = 0`, manifest `storeVersion = 2`.
- SHA-256 database: `85d70f7edcd9e9ce050e60b3a13285666546b555e01727ab8737dc057c1e5cda`.

The old builder also emitted an analysis JSON containing only benchmark
statistics; it is not needed to open or test the preserved Store.
