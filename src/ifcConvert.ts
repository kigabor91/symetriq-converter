import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function getIfcConvertPath(): string {
    return process.env.IFCCONVERT_PATH
        ?? path.resolve("./tools/ifcopenshell/IfcConvert.exe");
}

function getThreadCount(): string {
    const configuredThreads = Number(process.env.SYMETRIQ_IFCCONVERT_THREADS);
    const threads = Number.isInteger(configuredThreads) && configuredThreads > 0
        ? configuredThreads
        : 4;
    return String(threads);
}

export async function convertIfcToGlb(
    inputPath: string,
    outputPath: string,
    modelOffset?: [number, number, number],
    signal?: AbortSignal,
): Promise<void> {
    const executable = getIfcConvertPath();

    if (!fs.existsSync(executable)) {
        throw new Error(
            `IfcConvert was not found at ${executable}. Set IFCCONVERT_PATH or install it in tools/ifcopenshell.`,
        );
    }

    const linearDeflection = process.env.SYMETRIQ_MESHER_LINEAR_DEFLECTION ?? "0.001";
    const angularDeflection = process.env.SYMETRIQ_MESHER_ANGULAR_DEFLECTION ?? "0.5";

    // IfcConvert prompts before overwriting. This is an intermediate file
    // generated solely by this pipeline, so replacing this exact target is safe.
    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
    }

    const args = [
        "-j", getThreadCount(),
        "--no-normals",
        "--mesher-linear-deflection", linearDeflection,
        "--mesher-angular-deflection", angularDeflection,
        ...(modelOffset
            ? ["--model-offset", modelOffset.map((value) => value.toString()).join(";")]
            : []),
        inputPath,
        outputPath,
    ];

    await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Conversion cancelled."));
            return;
        }
        const processHandle = spawn(executable, args, { stdio: "inherit" });
        const abort = () => processHandle.kill();

        signal?.addEventListener("abort", abort, { once: true });
        processHandle.once("error", reject);
        processHandle.once("exit", (code) => {
            signal?.removeEventListener("abort", abort);
            if (signal?.aborted) {
                reject(new Error("Conversion cancelled."));
                return;
            }
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`IfcConvert failed with exit code ${code ?? "unknown"}.`));
            }
        });
    });
}
