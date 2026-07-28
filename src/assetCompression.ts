import * as fs from "node:fs";
import { promisify } from "node:util";
import {
    brotliCompress,
    constants as zlibConstants,
    gzip,
} from "node:zlib";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export interface CompressedAssetStats {
    sourceBytes: number;
    brotliBytes: number;
    gzipBytes: number;
}

/**
 * Creates immutable transfer variants alongside a Viewer asset.
 *
 * The raw file remains the compatibility fallback. The server selects `.br`
 * or `.gz` according to the requesting browser's Accept-Encoding header.
 */
export async function createCompressedAssetVariants(
    assetPath: string,
): Promise<CompressedAssetStats> {
    const source = await fs.promises.readFile(assetPath);
    const [brotli, gzipped] = await Promise.all([
        brotliCompressAsync(source, {
            params: {
                // Quality 8 is a strong space/time balance for assets that are
                // generated once during conversion and served many times.
                [zlibConstants.BROTLI_PARAM_QUALITY]: 8,
            },
        }),
        gzipAsync(source, { level: 9 }),
    ]);

    await Promise.all([
        fs.promises.writeFile(`${assetPath}.br`, brotli),
        fs.promises.writeFile(`${assetPath}.gz`, gzipped),
    ]);

    return {
        sourceBytes: source.length,
        brotliBytes: brotli.length,
        gzipBytes: gzipped.length,
    };
}
