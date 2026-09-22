import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
    UPLOAD_SESSION_VERSION,
    uploadFileKinds,
    uploadSessionStatuses,
    type UploadPartRecord,
    type UploadSessionRecord,
} from "./uploadSessionTypes.js";

const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseParts(value: unknown, totalParts: number, totalBytes: number, chunkSize: number): UploadPartRecord[] {
    if (!Array.isArray(value)) throw new Error("Upload session parts must be an array.");
    const seen = new Set<number>();
    const parts = value.map((part): UploadPartRecord => {
        if (!isRecord(part)
            || !Number.isSafeInteger(part.partNumber)
            || Number(part.partNumber) < 0
            || Number(part.partNumber) >= totalParts
            || !Number.isSafeInteger(part.size)
            || Number(part.size) <= 0
            || typeof part.sha256 !== "string"
            || !sha256Pattern.test(part.sha256)
            || !validTimestamp(part.completedAt)) {
            throw new Error("Upload session contains an invalid part record.");
        }
        const partNumber = Number(part.partNumber);
        if (seen.has(partNumber)) throw new Error("Upload session contains duplicate part records.");
        const expectedSize = Math.min(chunkSize, totalBytes - (partNumber * chunkSize));
        if (Number(part.size) !== expectedSize) {
            throw new Error("Upload session part size does not match its expected chunk size.");
        }
        seen.add(partNumber);
        return {
            partNumber,
            size: Number(part.size),
            sha256: part.sha256,
            completedAt: part.completedAt,
        };
    }).sort((left, right) => left.partNumber - right.partNumber);
    const receivedBytes = parts.reduce((sum, part) => sum + part.size, 0);
    if (!Number.isSafeInteger(receivedBytes) || receivedBytes > totalBytes) {
        throw new Error("Upload session part sizes exceed the declared file size.");
    }
    return parts;
}

export function parseUploadSessionRecord(value: unknown, expectedUploadId?: string): UploadSessionRecord {
    if (!isRecord(value)) throw new Error("Upload session manifest must be an object.");
    const uploadId = value.uploadId;
    const totalBytes = value.totalBytes;
    const chunkSize = value.chunkSize;
    const totalParts = value.totalParts;
    const receivedBytes = value.receivedBytes;
    if (value.version !== UPLOAD_SESSION_VERSION
        || typeof uploadId !== "string"
        || !uploadIdPattern.test(uploadId)
        || (expectedUploadId !== undefined && uploadId !== expectedUploadId)
        || typeof value.projectId !== "string"
        || value.projectId.length === 0
        || typeof value.filename !== "string"
        || value.filename.length === 0
        || typeof value.normalizedExtension !== "string"
        || typeof value.mimeType !== "string"
        || !uploadFileKinds.includes(value.fileKind as typeof uploadFileKinds[number])
        || (value.operation !== "create" && value.operation !== "replace")
        || typeof value.reservedFileId !== "string"
        || !uploadIdPattern.test(value.reservedFileId)
        || !Number.isSafeInteger(totalBytes)
        || Number(totalBytes) <= 0
        || !Number.isSafeInteger(chunkSize)
        || Number(chunkSize) <= 0
        || !Number.isSafeInteger(totalParts)
        || Number(totalParts) !== Math.ceil(Number(totalBytes) / Number(chunkSize))
        || !Number.isSafeInteger(receivedBytes)
        || Number(receivedBytes) < 0
        || Number(receivedBytes) > Number(totalBytes)
        || !uploadSessionStatuses.includes(value.status as typeof uploadSessionStatuses[number])
        || !validTimestamp(value.createdAt)
        || !validTimestamp(value.updatedAt)
        || !validTimestamp(value.expiresAt)) {
        throw new Error("Upload session manifest is invalid.");
    }
    if (value.expectedSha256 !== undefined
        && (typeof value.expectedSha256 !== "string" || !sha256Pattern.test(value.expectedSha256))) {
        throw new Error("Upload session expected SHA-256 is invalid.");
    }
    if (value.idempotencyKey !== undefined && typeof value.idempotencyKey !== "string") {
        throw new Error("Upload session idempotency key is invalid.");
    }
    const parts = parseParts(value.parts, Number(totalParts), Number(totalBytes), Number(chunkSize));
    if (parts.reduce((sum, part) => sum + part.size, 0) !== Number(receivedBytes)) {
        throw new Error("Upload session received byte count does not match its parts.");
    }
    return value as unknown as UploadSessionRecord;
}

export class UploadSessionRepository {
    constructor(private readonly rootDirectory: string) {}

    getRootDirectory(): string {
        return this.rootDirectory;
    }

    getSessionDirectory(uploadId: string): string {
        this.assertUploadId(uploadId);
        return path.join(this.rootDirectory, uploadId);
    }

    getPartsDirectory(uploadId: string): string {
        return path.join(this.getSessionDirectory(uploadId), "parts");
    }

    getPartPath(uploadId: string, partNumber: number): string {
        return path.join(this.getPartsDirectory(uploadId), `${this.partFilename(partNumber)}.part`);
    }

    getTemporaryPartPath(uploadId: string, partNumber: number, temporaryId: string): string {
        return path.join(this.getPartsDirectory(uploadId), `.${this.partFilename(partNumber)}.${temporaryId}.tmp`);
    }

    create(session: UploadSessionRecord): void {
        const sessionDirectory = this.getSessionDirectory(session.uploadId);
        fs.mkdirSync(this.rootDirectory, { recursive: true });
        fs.mkdirSync(sessionDirectory, { recursive: false });
        fs.mkdirSync(this.getPartsDirectory(session.uploadId), { recursive: false });
        try {
            this.writeManifest(session);
        } catch (error) {
            fs.rmSync(sessionDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    save(session: UploadSessionRecord): void {
        if (!fs.existsSync(this.getSessionDirectory(session.uploadId))) {
            throw new Error(`Upload session ${session.uploadId} does not exist.`);
        }
        this.writeManifest(session);
    }

    get(uploadId: string): UploadSessionRecord | undefined {
        if (!uploadIdPattern.test(uploadId)) return undefined;
        const manifestPath = this.getManifestPath(uploadId);
        if (!fs.existsSync(manifestPath)) return undefined;
        return parseUploadSessionRecord(JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown, uploadId);
    }

    findByIdempotencyKey(projectId: string, idempotencyKey: string): UploadSessionRecord | undefined {
        if (!fs.existsSync(this.rootDirectory)) return undefined;
        for (const entry of fs.readdirSync(this.rootDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory() || !uploadIdPattern.test(entry.name)) continue;
            const session = this.get(entry.name);
            if (session?.projectId === projectId && session.idempotencyKey === idempotencyKey) return session;
        }
        return undefined;
    }

    assertCommittedPartStorage(session: UploadSessionRecord): void {
        const partsDirectory = this.getPartsDirectory(session.uploadId);
        const expected = new Map(session.parts.map((part) => [this.partFilename(part.partNumber), part]));
        if (!fs.existsSync(partsDirectory)) {
            if (expected.size > 0) throw new Error("Upload session part storage is missing committed files.");
            return;
        }
        const actual = fs.readdirSync(partsDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /^\d{8}\.part$/.test(entry.name));
        for (const entry of actual) {
            if (!expected.has(entry.name.slice(0, -".part".length))) {
                throw new Error("Upload session part storage contains an unrecorded committed file.");
            }
        }
        for (const [filename, part] of expected) {
            const partPath = path.join(partsDirectory, `${filename}.part`);
            if (!fs.existsSync(partPath) || fs.statSync(partPath).size !== part.size) {
                throw new Error("Upload session part storage does not match its manifest.");
            }
        }
    }

    removeTemporaryData(uploadId: string): void {
        const sessionDirectory = this.getSessionDirectory(uploadId);
        for (const entry of ["parts", "incoming"]) {
            fs.rmSync(path.join(sessionDirectory, entry), { recursive: true, force: true });
        }
        fs.rmSync(path.join(sessionDirectory, "assembled.tmp"), { force: true });
    }

    private getManifestPath(uploadId: string): string {
        return path.join(this.getSessionDirectory(uploadId), "session.json");
    }

    private writeManifest(session: UploadSessionRecord): void {
        parseUploadSessionRecord(session, session.uploadId);
        const manifestPath = this.getManifestPath(session.uploadId);
        const temporaryPath = path.join(
            this.getSessionDirectory(session.uploadId),
            `session.json.${randomUUID()}.tmp`,
        );
        let descriptor: number | undefined;
        try {
            descriptor = fs.openSync(temporaryPath, "wx");
            fs.writeFileSync(descriptor, `${JSON.stringify(session, null, 2)}\n`, "utf8");
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporaryPath, manifestPath);
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            fs.rmSync(temporaryPath, { force: true });
        }
    }

    private assertUploadId(uploadId: string): void {
        if (!uploadIdPattern.test(uploadId)) throw new Error("Invalid upload ID.");
    }

    private partFilename(partNumber: number): string {
        if (!Number.isSafeInteger(partNumber) || partNumber < 0) {
            throw new Error("Invalid upload part number.");
        }
        return partNumber.toString().padStart(8, "0");
    }
}
