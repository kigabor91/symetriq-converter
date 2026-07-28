import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createCompressedAssetVariants } from "./assetCompression.js";

test("compressed Viewer asset variants round-trip to the original file", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "symetriq-compression-"));
    const assetPath = path.join(directory, "asset.metadata.json");
    const source = Buffer.from(JSON.stringify({ value: "repeated ".repeat(2000) }));
    try {
        writeFileSync(assetPath, source);
        const stats = await createCompressedAssetVariants(assetPath);

        assert.equal(stats.sourceBytes, source.length);
        assert.ok(stats.brotliBytes < source.length);
        assert.ok(stats.gzipBytes < source.length);
        assert.deepEqual(brotliDecompressSync(readFileSync(`${assetPath}.br`)), source);
        assert.deepEqual(gunzipSync(readFileSync(`${assetPath}.gz`)), source);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
