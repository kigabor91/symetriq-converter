import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
    cleanupUploadFiles,
    parseContentLength,
    uploadPercent,
    UPLOAD_FILE_SIZE_LIMIT_BYTES,
} from "./uploadDiagnostics.js";

test("content-length parsing remains safe above the 2 GiB boundary", () => {
    const value = 2_300_000_000;
    assert.equal(parseContentLength(String(value)), value);
    assert.equal(value > 2_147_483_647, true);
    assert.equal(parseContentLength("2147483648"), 2_147_483_648);
    assert.equal(parseContentLength("not-a-number"), undefined);
});

test("upload size accounting uses the 20 GiB limit without int32 coercion", () => {
    assert.equal(UPLOAD_FILE_SIZE_LIMIT_BYTES, 20 * 1024 ** 3);
    assert.equal(UPLOAD_FILE_SIZE_LIMIT_BYTES > 2_147_483_647, true);
    assert.equal(uploadPercent(2_300_000_000, 2_300_000_000), 100);
});

test("aborted temporary upload files can be cleaned up deterministically", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symetriq-upload-test-"));
    const first = path.join(directory, "first.part");
    const second = path.join(directory, "second.part");
    fs.writeFileSync(first, Buffer.alloc(1024));
    fs.writeFileSync(second, Buffer.alloc(2048));
    const result = cleanupUploadFiles([first, second, first]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.removed.sort(), [first, second].sort());
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), false);
    fs.rmSync(directory, { recursive: true, force: true });
});

