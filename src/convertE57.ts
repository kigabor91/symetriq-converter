import { spawn } from "node:child_process";
import * as path from "node:path";

export interface E57ConversionResult {
    pointCount: number;
    panorama: {
        stations: Array<{
            id: string;
            name: string;
            sourceData3DGuid: string;
            position: [number, number, number];
            rotation: [number, number, number, number];
            faces: string[];
        }>;
    };
}

/**
 * Runs in a separate Python process so native E57 parsing cannot affect the
 * Node server. The worker writes a viewer-ready LAS file and JPEG cube faces.
 */
export function convertE57(
    inputPath: string,
    outputDirectory: string,
    fileId: string,
    sceneOrigin?: [number, number, number],
    signal?: AbortSignal,
): Promise<E57ConversionResult> {
    const workerPath = path.resolve("src/e57_worker.py");
    const args = [workerPath, inputPath, outputDirectory, fileId];
    if (sceneOrigin) args.push("--scene-origin", ...sceneOrigin.map(String));

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Conversion cancelled."));
            return;
        }
        const process = spawn("python", args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        process.stdout.setEncoding("utf8");
        process.stderr.setEncoding("utf8");
        process.stdout.on("data", (chunk: string) => { stdout += chunk; });
        process.stderr.on("data", (chunk: string) => { stderr += chunk; });
        const abort = () => process.kill();
        signal?.addEventListener("abort", abort, { once: true });
        process.on("error", reject);
        process.on("close", (code) => {
            signal?.removeEventListener("abort", abort);
            if (signal?.aborted) {
                reject(new Error("Conversion cancelled."));
                return;
            }
            if (code !== 0) {
                reject(new Error(stderr.trim() || `E57 worker stopped with code ${code}.`));
                return;
            }
            try {
                resolve(JSON.parse(stdout) as E57ConversionResult);
            } catch {
                reject(new Error(`E57 worker returned invalid output: ${stdout.slice(0, 500)}`));
            }
        });
    });
}
