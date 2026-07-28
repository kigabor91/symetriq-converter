import cors from "cors";
import express from "express";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import multer from "multer";
import { convertIfc } from "./convert.js";
import { convertE57 } from "./convertE57.js";
import {
    getDataDirectory,
    getProjectDirectory,
    readProjects,
    updateProject,
    writeProjects,
    type ProjectFileRecord,
    type ProjectIssueRecord,
    type ProjectPropertyViewRecord,
    type ProjectDisplayViewRecord,
    type ProjectRecord,
} from "./projectStore.js";

const port = Number(process.env.SYMETRIQ_SERVER_PORT ?? 3001);
const app = express();
const temporaryUploadDirectory = path.join(getDataDirectory(), "upload-temp");
fs.mkdirSync(temporaryUploadDirectory, { recursive: true });

const upload = multer({
    dest: temporaryUploadDirectory,
    // Structured E57 exports can be several gigabytes. Keep a protective
    // per-file ceiling, while allowing the large reality-capture uploads
    // that this service is designed to process.
    limits: { files: 20, fileSize: 20 * 1024 * 1024 * 1024 },
});

const supportedFileExtensions = new Set([".ifc", ".las", ".laz", ".e57"]);
// Preserve the dense E57 LOD wiring for a future streamed renderer, while
// keeping it off in the MVP to avoid generating a GPU-heavy 1/10 point cloud.
const enableBalancedE57Lod = false;

function removeStoredFileAssets(projectId: string, fileId: string): void {
    const projectDirectory = path.resolve(getProjectDirectory(projectId));
    const uploadsDirectory = path.join(projectDirectory, "uploads");
    if (fs.existsSync(uploadsDirectory)) {
        fs.readdirSync(uploadsDirectory).forEach((entry) => {
            if (path.parse(entry).name === fileId) {
                fs.rmSync(path.join(uploadsDirectory, entry), { force: true });
            }
        });
    }
    const convertedDirectory = path.resolve(projectDirectory, "converted", fileId);
    if (!convertedDirectory.startsWith(`${projectDirectory}${path.sep}`)) {
        throw new Error("Invalid project file location.");
    }
    fs.rmSync(convertedDirectory, { recursive: true, force: true });
}

function buildPointCloudPackage(
    projectId: string,
    fileId: string,
    extension: ".las" | ".laz",
    revision: number,
    isLocallyRebased = false,
) {
    const sourceDirectory = isLocallyRebased ? "converted" : "uploads";
    return {
        id: fileId,
        source: {
            format: extension.slice(1) as "las" | "laz",
            src: isLocallyRebased
                ? `/project-files/${projectId}/${sourceDirectory}/${fileId}/${fileId}${extension}?v=${revision}`
                : `/project-files/${projectId}/${sourceDirectory}/${fileId}${extension}?v=${revision}`,
        },
        // Fast is the responsive default for every uploaded point cloud.
        pointStride: 50,
        // This is an axis convention, not a project-specific correction:
        // LAS is East/North/Up whereas glTF/XKT is East/Up/-North.
        lasTransform: createLasToXktAxisTransform(),
    };
}

function buildDerivedPointCloudPackage(projectId: string, fileId: string, revision: number) {
    const convertedBase = `/project-files/${projectId}/converted/${fileId}`;
    return {
        id: fileId,
        source: {
            format: "las" as const,
            // Fast is the default for structured E57. Unlike LASLoader's
            // sequential skip, this file is spatially distributed by the
            // converter and therefore does not create scan-line gaps.
            src: `${convertedBase}/${fileId}.fast.las?v=${revision}`,
        },
        pointStride: 1,
        lodSources: {
            ...(enableBalancedE57Lod ? {
                "10": { format: "las" as const, src: `${convertedBase}/${fileId}.balanced.las?v=${revision}` },
            } : {}),
            "50": { format: "las" as const, src: `${convertedBase}/${fileId}.fast.las?v=${revision}` },
            "80": { format: "las" as const, src: `${convertedBase}/${fileId}.very-fast.las?v=${revision}` },
        },
        lasTransform: createLasToXktAxisTransform(),
    };
}

/**
 * IFC geometry reaches XKT through glTF, whose axes are East/Up/-North.
 * LAS is East/North/Up. The project-origin rebase is performed in the
 * converter for IFC and in the LAS header below; this matrix only expresses
 * the fixed renderer axis convention.
 */
function createLasToXktAxisTransform(): number[] {
    return [
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1,
    ];
}

/**
 * LAS/LAZ point records are stored as integers plus header offsets. Rewriting
 * just those offsets creates a local-coordinate copy without changing a single
 * measured point or the user's original upload.
 */
function createLocallyRebasedPointCloud(
    projectId: string,
    fileId: string,
    extension: ".las" | ".laz",
    sceneOrigin: [number, number, number],
): void {
    const projectDirectory = getProjectDirectory(projectId);
    const inputPath = path.join(projectDirectory, "uploads", `${fileId}${extension}`);
    const outputDirectory = path.join(projectDirectory, "converted", fileId);
    const outputPath = path.join(outputDirectory, `${fileId}${extension}`);
    if (!fs.existsSync(inputPath)) return;

    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.copyFileSync(inputPath, outputPath);
    const descriptor = fs.openSync(outputPath, "r+");
    try {
        const offsets = [155, 163, 171]; // LAS public-header X/Y/Z offset fields
        offsets.forEach((offsetPosition, index) => {
            const valueBuffer = Buffer.allocUnsafe(8);
            fs.readSync(descriptor, valueBuffer, 0, 8, offsetPosition);
            valueBuffer.writeDoubleLE(valueBuffer.readDoubleLE(0) - sceneOrigin[index]!, 0);
            fs.writeSync(descriptor, valueBuffer, 0, 8, offsetPosition);
        });
    } finally {
        fs.closeSync(descriptor);
    }
}

/** Converts an East/North/Up source displacement to glTF/XKT axes. */
function sourceDisplacementToXkt(
    sourceOrigin: [number, number, number],
    sceneOrigin: [number, number, number],
): [number, number, number] {
    const east = sourceOrigin[0] - sceneOrigin[0];
    const north = sourceOrigin[1] - sceneOrigin[1];
    const up = sourceOrigin[2] - sceneOrigin[2];
    return [
        east,
        up,
        -north,
    ];
}

function removeProjectDirectory(projectId: string): void {
    const projectsDirectory = path.resolve(getDataDirectory(), "projects");
    const projectDirectory = path.resolve(getProjectDirectory(projectId));
    if (!projectDirectory.startsWith(`${projectsDirectory}${path.sep}`)) {
        throw new Error("Invalid project location.");
    }
    fs.rmSync(projectDirectory, { recursive: true, force: true });
}

/** Serves a pre-compressed XKT or metadata response when the browser supports it. */
function servePrecompressedViewerAsset(
    request: express.Request,
    response: express.Response,
    next: express.NextFunction,
): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
        next();
        return;
    }

    const encoding = request.acceptsEncodings("br", "gzip", "identity");
    if (encoding !== "br" && encoding !== "gzip") {
        next();
        return;
    }

    let relativePath: string;
    try {
        relativePath = decodeURIComponent(request.path).replace(/^[/\\]+/, "");
    } catch {
        next();
        return;
    }
    if (!relativePath.endsWith(".xkt") && !relativePath.endsWith(".metadata.json")) {
        next();
        return;
    }

    const projectsDirectory = path.resolve(getDataDirectory(), "projects");
    const assetPath = path.resolve(projectsDirectory, relativePath);
    if (!assetPath.startsWith(`${projectsDirectory}${path.sep}`)) {
        next();
        return;
    }

    const compressedPath = `${assetPath}.${encoding === "br" ? "br" : "gz"}`;
    if (!fs.existsSync(compressedPath)) {
        next();
        return;
    }

    response.setHeader("Content-Encoding", encoding);
    response.setHeader("Vary", "Accept-Encoding");
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader(
        "Content-Type",
        relativePath.endsWith(".metadata.json") ? "application/json; charset=utf-8" : "application/octet-stream",
    );
    response.sendFile(compressedPath, (error) => {
        if (error) next(error);
    });
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));
app.use("/project-files", servePrecompressedViewerAsset);
app.use(
    "/project-files",
    express.static(path.join(getDataDirectory(), "projects"), {
        fallthrough: false,
        // Every viewer-facing converted asset URL contains a revision query
        // parameter ("?v=N"). Uploaded assets and issue screenshots are
        // immutable too. This lets a production reverse proxy/browser cache
        // large XKT/LAS/panorama responses aggressively without serving an
        // outdated replacement file.
        immutable: true,
        maxAge: "365d",
        setHeaders(response, filePath) {
            const extension = path.extname(filePath).toLowerCase();
            response.setHeader("X-Content-Type-Options", "nosniff");
            if ([".xkt", ".json"].includes(extension)) {
                response.setHeader("Vary", "Accept-Encoding");
            }
            // LAS/LAZ and JPEG are already compressed binary formats. Leaving
            // them unencoded preserves efficient byte-range delivery. JSON is
            // intentionally cacheable too; IIS can Brotli/Gzip it upstream.
            if ([".las", ".laz", ".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
                response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            }
        },
    }),
);

app.get("/api/projects", (_request, response) => {
    response.json(readProjects());
});

app.post("/api/projects", (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    const description = String(request.body?.description ?? "").trim();
    if (!name) {
        response.status(400).json({ error: "Project name is required." });
        return;
    }
    const now = new Date().toISOString();
    const project: ProjectRecord = {
        id: randomUUID(),
        name,
        description,
        createdAt: now,
        updatedAt: now,
        files: [],
    };
    const projects = readProjects();
    projects.push(project);
    writeProjects(projects);
    fs.mkdirSync(path.join(getProjectDirectory(project.id), "uploads"), { recursive: true });
    response.status(201).json(project);
});

app.get("/api/projects/:projectId", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.json(project);
});

app.put("/api/projects/:projectId", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const name = String(request.body?.name ?? "").trim();
    const description = String(request.body?.description ?? "").trim();
    if (!name) {
        response.status(400).json({ error: "Project name is required." });
        return;
    }
    const project = updateProject(projectId, (storedProject) => {
        storedProject.name = name;
        storedProject.description = description;
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.json(project);
});

app.put("/api/projects/:projectId/plan-settings", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const referenceId = request.body?.planReferenceModelId;
    const range = request.body?.planViewRange;
    if (referenceId !== undefined && typeof referenceId !== "string") {
        response.status(400).json({ error: "Plan reference must be an IFC model ID." });
        return;
    }
    if (range !== undefined && (!range || ![range.lower, range.cut, range.upper].every((value: unknown) => typeof value === "number") || range.lower > range.cut || range.cut > range.upper)) {
        response.status(400).json({ error: "Plan range must satisfy lower ≤ cut ≤ upper." });
        return;
    }
    const project = updateProject(projectId, (storedProject) => {
        if (referenceId !== undefined) {
            const isIfc = storedProject.files.some((file) => file.id === referenceId && file.kind === "ifc");
            if (!isIfc) throw new Error("The selected plan reference is not an IFC model.");
            storedProject.planReferenceModelId = referenceId;
        }
        if (range !== undefined) storedProject.planViewRange = range;
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.json(project);
});

app.delete("/api/projects/:projectId", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    if (project.files.some((file) => file.status === "queued" || file.status === "processing")) {
        response.status(409).json({ error: "A project cannot be deleted while conversion is running." });
        return;
    }
    try {
        removeProjectDirectory(projectId);
        writeProjects(readProjects().filter((candidate) => candidate.id !== projectId));
        response.status(204).end();
    } catch (error) {
        response.status(500).json({ error: "The project files could not be deleted." });
    }
});

app.get("/api/projects/:projectId/property-views", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.json(project.propertyViews ?? []);
});

app.post("/api/projects/:projectId/property-views", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const name = String(request.body?.name ?? "").trim();
    const propertyKeys = request.body?.propertyKeys;
    if (!name || !Array.isArray(propertyKeys) || propertyKeys.some((key) => typeof key !== "string")) {
        response.status(400).json({ error: "A view name and property keys are required." });
        return;
    }
    const view: ProjectPropertyViewRecord = {
        id: randomUUID(),
        name,
        propertyKeys: [...new Set(propertyKeys)],
        createdAt: new Date().toISOString(),
    };
    const project = updateProject(projectId, (storedProject) => {
        storedProject.propertyViews ??= [];
        storedProject.propertyViews.push(view);
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.status(201).json(view);
});

app.delete("/api/projects/:projectId/property-views/:viewId", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const viewId = String(request.params.viewId ?? "");
    let deleted = false;
    const project = updateProject(projectId, (storedProject) => {
        const views = storedProject.propertyViews ?? [];
        deleted = views.some((view) => view.id === viewId);
        storedProject.propertyViews = views.filter((view) => view.id !== viewId);
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    if (!deleted) {
        response.status(404).json({ error: "Property view not found." });
        return;
    }
    response.status(204).end();
});

app.get("/api/projects/:projectId/display-views", (request, response) => {
    const project = readProjects().find(({ id }) => id === String(request.params.projectId ?? ""));
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.json(project.displayViews ?? []);
});

app.post("/api/projects/:projectId/display-views", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const name = String(request.body?.name ?? "").trim();
    const mode = request.body?.mode;
    const opacity = Number(request.body?.opacity);
    const colorOverride = request.body?.colorOverride;
    const supportedModes = new Set(["shaded", "xray"]);
    if (!name || !supportedModes.has(mode) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        response.status(400).json({ error: "A valid display view name and settings are required." });
        return;
    }
    if (colorOverride !== undefined && (
        !colorOverride || typeof colorOverride.propertyKey !== "string"
        || !Array.isArray(colorOverride.values) || colorOverride.values.some((value: unknown) => typeof value !== "string")
        || !/^#[0-9a-f]{6}$/i.test(String(colorOverride.color ?? ""))
    )) {
        response.status(400).json({ error: "The color override is invalid." });
        return;
    }
    const normalizedColorOverride = colorOverride === undefined ? undefined : {
        propertyKey: colorOverride.propertyKey as string,
        values: colorOverride.values as string[],
        color: colorOverride.color as string,
    };
    const view: ProjectDisplayViewRecord = {
        id: randomUUID(), name, mode, opacity,
        ...(normalizedColorOverride ? {
            colorOverride: {
                propertyKey: normalizedColorOverride.propertyKey,
                values: [...new Set(normalizedColorOverride.values)],
                color: normalizedColorOverride.color,
            },
        } : {}),
        createdAt: new Date().toISOString(),
    };
    const project = updateProject(projectId, (storedProject) => {
        storedProject.displayViews ??= [];
        storedProject.displayViews.push(view);
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.status(201).json(view);
});

app.delete("/api/projects/:projectId/display-views/:viewId", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const viewId = String(request.params.viewId ?? "");
    let deleted = false;
    const project = updateProject(projectId, (storedProject) => {
        const views = storedProject.displayViews ?? [];
        deleted = views.some((view) => view.id === viewId);
        storedProject.displayViews = views.filter((view) => view.id !== viewId);
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    if (!deleted) {
        response.status(404).json({ error: "Display view not found." });
        return;
    }
    response.status(204).end();
});

app.get("/api/projects/:projectId/issues", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    response.json(project.issues ?? []);
});

app.post("/api/projects/:projectId/issues", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }

    const title = String(request.body?.title ?? "").trim();
    const description = String(request.body?.description ?? "").trim();
    const category = String(request.body?.category ?? "").trim();
    const screenshotData = String(request.body?.screenshotData ?? "");
    const viewpoint = request.body?.viewpoint;
    const packageVisibility = request.body?.packageVisibility;
    if (!title) {
        response.status(400).json({ error: "Issue title is required." });
        return;
    }
    const screenshotMatch = /^data:image\/(png|jpeg);base64,(.+)$/.exec(screenshotData);
    if (!screenshotMatch) {
        response.status(400).json({ error: "A PNG or JPEG scene snapshot is required." });
        return;
    }
    const [, screenshotFormat, screenshotBase64] = screenshotMatch;
    if (!viewpoint || typeof viewpoint !== "object") {
        response.status(400).json({ error: "A scene viewpoint is required." });
        return;
    }
    if (!packageVisibility || typeof packageVisibility !== "object") {
        response.status(400).json({ error: "Scene visibility state is required." });
        return;
    }

    const issueId = randomUUID();
    const issuesDirectory = path.join(getProjectDirectory(projectId), "issues");
    fs.mkdirSync(issuesDirectory, { recursive: true });
    const screenshotExtension = screenshotFormat === "jpeg" ? "jpg" : "png";
    const screenshotPath = path.join(issuesDirectory, `${issueId}.${screenshotExtension}`);
    try {
        fs.writeFileSync(
            screenshotPath,
            Buffer.from(screenshotBase64 ?? "", "base64"),
        );
    } catch (error) {
        response.status(400).json({ error: "The scene snapshot could not be saved." });
        return;
    }

    const now = new Date().toISOString();
    const issue: ProjectIssueRecord = {
        id: issueId,
        title,
        description,
        status: "open",
        createdAt: now,
        updatedAt: now,
        screenshotSrc: `/project-files/${projectId}/issues/${issueId}.${screenshotExtension}`,
        viewpoint: viewpoint as Record<string, unknown>,
        packageVisibility: Object.fromEntries(
            Object.entries(packageVisibility as Record<string, unknown>)
                .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
        ),
        ...(request.body?.selection && typeof request.body.selection === "object"
            ? { selection: request.body.selection }
            : {}),
        ...(category ? { category } : {}),
    };

    updateProject(projectId, (storedProject) => {
        storedProject.issues ??= [];
        storedProject.issues.push(issue);
    });
    response.status(201).json(issue);
});

app.patch("/api/projects/:projectId/issues/:issueId", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const issueId = String(request.params.issueId ?? "");
    const requestedStatus = request.body?.status;
    const hasStatus = requestedStatus !== undefined;
    const hasTitle = request.body?.title !== undefined;
    const hasDescription = request.body?.description !== undefined;
    const hasCategory = request.body?.category !== undefined;
    if (!hasStatus && !hasTitle && !hasDescription && !hasCategory) {
        response.status(400).json({ error: "No issue changes were provided." });
        return;
    }
    if (hasStatus && requestedStatus !== "open" && requestedStatus !== "resolved" && requestedStatus !== "closed") {
        response.status(400).json({ error: "Issue status must be open, resolved or closed." });
        return;
    }
    const title = hasTitle ? String(request.body.title ?? "").trim() : undefined;
    const description = hasDescription ? String(request.body.description ?? "").trim() : undefined;
    const category = hasCategory ? String(request.body.category ?? "").trim() : undefined;
    if (hasTitle && !title) {
        response.status(400).json({ error: "Issue title is required." });
        return;
    }
    let updatedIssue: ProjectIssueRecord | undefined;
    const project = updateProject(projectId, (storedProject) => {
        const issue = storedProject.issues?.find((candidate) => candidate.id === issueId);
        if (!issue) return;
        if (hasStatus) issue.status = requestedStatus;
        if (title !== undefined) issue.title = title;
        if (description !== undefined) issue.description = description;
        if (category !== undefined) {
            if (category) issue.category = category;
            else delete issue.category;
        }
        issue.updatedAt = new Date().toISOString();
        updatedIssue = issue;
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    if (!updatedIssue) {
        response.status(404).json({ error: "Issue not found." });
        return;
    }
    response.json(updatedIssue);
});

app.post("/api/projects/:projectId/issues/:issueId/comments", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const issueId = String(request.params.issueId ?? "");
    const authorName = String(request.body?.authorName ?? "").trim();
    const body = String(request.body?.body ?? "").trim();
    if (!authorName || !body) {
        response.status(400).json({ error: "Comment name and text are required." });
        return;
    }

    let updatedIssue: ProjectIssueRecord | undefined;
    const project = updateProject(projectId, (storedProject) => {
        const issue = storedProject.issues?.find((candidate) => candidate.id === issueId);
        if (!issue) return;
        const now = new Date().toISOString();
        issue.comments ??= [];
        issue.comments.push({ id: randomUUID(), authorName, body, createdAt: now });
        issue.updatedAt = now;
        updatedIssue = issue;
    });
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    if (!updatedIssue) {
        response.status(404).json({ error: "Issue not found." });
        return;
    }
    response.status(201).json(updatedIssue);
});

let conversionQueue = Promise.resolve();
const conversionControllers = new Map<string, AbortController>();

function conversionKey(projectId: string, fileId: string): string {
    return `${projectId}:${fileId}`;
}

function isConversionCancelled(projectId: string, fileId: string, revision: number, controller: AbortController): boolean {
    const file = readProjects()
        .find((project) => project.id === projectId)
        ?.files.find((candidate) => candidate.id === fileId);
    return controller.signal.aborted || !file || file.revision !== revision || file.status === "cancelled";
}

function queueE57Conversion(
    projectId: string,
    fileId: string,
    inputPath: string,
    revision: number,
): void {
    const controller = new AbortController();
    const key = conversionKey(projectId, fileId);
    conversionControllers.set(key, controller);
    conversionQueue = conversionQueue
        .then(async () => {
            if (isConversionCancelled(projectId, fileId, revision, controller)) return;
            updateProject(projectId, (project) => {
                const file = project.files.find(({ id }) => id === fileId);
                if (file && file.revision === revision && file.status === "queued") file.status = "processing";
            });
            if (isConversionCancelled(projectId, fileId, revision, controller)) return;
            const outputDirectory = path.join(getProjectDirectory(projectId), "converted", fileId);
            const sceneOrigin = readProjects().find(({ id }) => id === projectId)?.sceneOrigin;
            const conversion = await convertE57(inputPath, outputDirectory, fileId, sceneOrigin, controller.signal);
            if (isConversionCancelled(projectId, fileId, revision, controller)) {
                fs.rmSync(outputDirectory, { recursive: true, force: true });
                return;
            }
            updateProject(projectId, (project) => {
                const file = project.files.find(({ id }) => id === fileId);
                if (!file) return;
                file.status = "ready";
                file.pointCloud = buildDerivedPointCloudPackage(projectId, fileId, revision);
                file.panorama = {
                    stations: conversion.panorama.stations.map((station) => ({
                        ...station,
                        faces: station.faces.map((face) =>
                            `/project-files/${projectId}/converted/${fileId}/${face}?v=${revision}`,
                        ),
                    })),
                };
                delete file.error;
            });
        })
        .catch((error: unknown) => {
            if (isConversionCancelled(projectId, fileId, revision, controller)) return;
            const message = error instanceof Error ? error.message : String(error);
            updateProject(projectId, (project) => {
                const file = project.files.find(({ id }) => id === fileId);
                if (!file) return;
                file.status = "error";
                file.error = message;
            });
            console.error(`E57 conversion failed for ${fileId}:`, error);
        })
        .finally(() => {
            if (conversionControllers.get(key) === controller) conversionControllers.delete(key);
        });
}

function queueIfcConversion(
    projectId: string,
    fileId: string,
    inputPath: string,
    revision: number,
): void {
    const controller = new AbortController();
    const key = conversionKey(projectId, fileId);
    conversionControllers.set(key, controller);
    conversionQueue = conversionQueue
        .then(async () => {
            if (isConversionCancelled(projectId, fileId, revision, controller)) return;
            updateProject(projectId, (project) => {
                const file = project.files.find(({ id }) => id === fileId);
                if (file && file.revision === revision && file.status === "queued") file.status = "processing";
            });
            if (isConversionCancelled(projectId, fileId, revision, controller)) return;
            const outputDirectory = path.join(
                getProjectDirectory(projectId),
                "converted",
                fileId,
            );
            const conversion = await convertIfc(inputPath, outputDirectory, fileId, controller.signal);
            if (isConversionCancelled(projectId, fileId, revision, controller)) {
                fs.rmSync(outputDirectory, { recursive: true, force: true });
                return;
            }
            const publicBase = `/project-files/${projectId}/converted/${fileId}`;
            const structuredE57ToReprocess: Array<{
                id: string;
                inputPath: string;
                revision: number;
            }> = [];
            updateProject(projectId, (project) => {
                const file = project.files.find(({ id }) => id === fileId);
                if (!file) return;
                const coordinateReference = conversion.coordinateReference;
                const previousSceneOrigin = project.sceneOrigin;
                const hasOtherIfcModel = project.files.some((candidate) =>
                    candidate.kind === "ifc" && candidate.id !== fileId,
                );
                // A single-model project may replace a Project Base Point IFC
                // with a Shared Coordinates IFC (or vice versa). In that case
                // the old project origin must never survive the replacement.
                if (coordinateReference && !hasOtherIfcModel) {
                    project.sceneOrigin = coordinateReference.origin;
                } else if (!project.sceneOrigin && coordinateReference) {
                    project.sceneOrigin = coordinateReference.origin;
                }
                const sceneOrigin = project.sceneOrigin;
                const sceneOriginChanged = Boolean(coordinateReference && sceneOrigin && (
                    !previousSceneOrigin || coordinateReference.origin.some(
                        (value, index) => Math.abs(value - previousSceneOrigin[index]!) > 0.000001,
                    )
                ));
                file.status = "ready";
                file.model = {
                    id: fileId,
                    geometry: { format: "xkt", src: `${publicBase}/${fileId}.xkt?v=${revision}` },
                    metadata: {
                        format: "json",
                        src: `${publicBase}/${fileId}.metadata.json?v=${revision}`,
                    },
                    ...(coordinateReference ? { coordinateReference } : {}),
                    ...(coordinateReference && sceneOrigin ? {
                        // Each IFC has already been rebased by its own Project
                        // Base Point during GLB conversion. Restore only its
                        // relative displacement within this project scene.
                        transform: {
                            position: sourceDisplacementToXkt(
                                coordinateReference.origin,
                                sceneOrigin,
                            ),
                        },
                    } : {}),
                };
                if (sceneOrigin && sceneOriginChanged) {
                    project.files
                        .filter((candidate) => candidate.kind === "point-cloud" && candidate.pointCloud)
                        .forEach((pointCloudFile) => {
                            const extension = path.extname(pointCloudFile.originalName).toLowerCase() as ".las" | ".laz";
                            createLocallyRebasedPointCloud(
                                projectId,
                                pointCloudFile.id,
                                extension,
                                sceneOrigin,
                            );
                            pointCloudFile.pointCloud = buildPointCloudPackage(
                                projectId,
                                pointCloudFile.id,
                                extension,
                                pointCloudFile.revision ?? 1,
                                true,
                            );
                        });
                }
                // Structured E57 outputs contain already-rebased LAS and
                // panorama station coordinates. When an IFC establishes a
                // different survey origin, rebuild each ready E57 from its
                // original upload so it cannot remain in the old scene.
                if (sceneOriginChanged) {
                    project.files
                        .filter((candidate) => candidate.kind === "structured-e57" && candidate.status === "ready")
                        .forEach((e57File) => {
                            const nextRevision = (e57File.revision ?? 0) + 1;
                            e57File.revision = nextRevision;
                            e57File.status = "queued";
                            delete e57File.pointCloud;
                            delete e57File.panorama;
                            structuredE57ToReprocess.push({
                                id: e57File.id,
                                inputPath: path.join(getProjectDirectory(projectId), "uploads", `${e57File.id}.e57`),
                                revision: nextRevision,
                            });
                        });
                }
                delete file.error;
            });
            structuredE57ToReprocess.forEach((e57) => {
                queueE57Conversion(projectId, e57.id, e57.inputPath, e57.revision);
            });
        })
        .catch((error: unknown) => {
            if (isConversionCancelled(projectId, fileId, revision, controller)) return;
            const message = error instanceof Error ? error.message : String(error);
            updateProject(projectId, (project) => {
                const file = project.files.find(({ id }) => id === fileId);
                if (!file) return;
                file.status = "error";
                file.error = message;
            });
            console.error(`Conversion failed for ${fileId}:`, error);
        })
        .finally(() => {
            if (conversionControllers.get(key) === controller) conversionControllers.delete(key);
        });
}

app.post(
    "/api/projects/:projectId/files",
    upload.array("files", 20),
    (request, response) => {
        const projectId = String(request.params.projectId ?? "");
        const project = readProjects().find(({ id }) => id === projectId);
        const uploadedFiles = (request.files ?? []) as Express.Multer.File[];
        if (!project) {
            uploadedFiles.forEach((file) => fs.rmSync(file.path, { force: true }));
            response.status(404).json({ error: "Project not found." });
            return;
        }
        if (uploadedFiles.length === 0) {
            response.status(400).json({ error: "No files were uploaded." });
            return;
        }

        const acceptedFiles: Array<{
            record: ProjectFileRecord;
            inputPath: string;
        }> = [];
        for (const uploadedFile of uploadedFiles) {
            const extension = path.extname(uploadedFile.originalname).toLowerCase();
            if (!supportedFileExtensions.has(extension)) {
                fs.rmSync(uploadedFile.path, { force: true });
                continue;
            }
            const fileId = randomUUID();
            const uploadsDirectory = path.join(getProjectDirectory(projectId), "uploads");
            fs.mkdirSync(uploadsDirectory, { recursive: true });
            const inputPath = path.join(uploadsDirectory, `${fileId}${extension}`);
            fs.renameSync(uploadedFile.path, inputPath);
            const isIfc = extension === ".ifc";
            const isE57 = extension === ".e57";
            const record: ProjectFileRecord = {
                id: fileId,
                revision: 1,
                originalName: uploadedFile.originalname,
                kind: isIfc ? "ifc" : isE57 ? "structured-e57" : "point-cloud",
                status: isIfc || isE57 ? "queued" : "ready",
                ...(!isIfc && !isE57 && {
                    pointCloud: buildPointCloudPackage(
                        projectId,
                        fileId,
                        extension as ".las" | ".laz",
                        1,
                        Boolean(project.sceneOrigin),
                    ),
                }),
            };
            if (!isIfc && !isE57 && project.sceneOrigin) {
                createLocallyRebasedPointCloud(
                    projectId,
                    fileId,
                    extension as ".las" | ".laz",
                    project.sceneOrigin,
                );
            }
            acceptedFiles.push({ record, inputPath });
        }

        if (acceptedFiles.length === 0) {
            response.status(400).json({ error: "Only IFC, LAS, LAZ and structured E57 files are supported." });
            return;
        }

        updateProject(projectId, (storedProject) => {
            storedProject.files.push(...acceptedFiles.map(({ record }) => record));
        });
        acceptedFiles
            .filter(({ record }) => record.kind === "ifc")
            .forEach(({ record, inputPath }) => {
                queueIfcConversion(projectId, record.id, inputPath, record.revision ?? 1);
            });
        acceptedFiles
            .filter(({ record }) => record.kind === "structured-e57")
            .forEach(({ record, inputPath }) => {
                queueE57Conversion(projectId, record.id, inputPath, record.revision ?? 1);
            });

        response.status(202).json(
            readProjects().find(({ id }) => id === projectId),
        );
    },
);

// Retries a failed IFC/E57 conversion from the already stored original upload.
// This avoids forcing a multi-gigabyte file to be uploaded again after a
// converter update or a transient parsing failure.
app.post("/api/projects/:projectId/files/:fileId/retry", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const fileId = String(request.params.fileId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    const file = project?.files.find((candidate) => candidate.id === fileId);
    if (!project || !file) {
        response.status(404).json({ error: "Project file not found." });
        return;
    }
    if ((file.status !== "error" && file.status !== "cancelled") || (file.kind !== "ifc" && file.kind !== "structured-e57")) {
        response.status(409).json({ error: "Only failed or cancelled IFC or structured E57 conversions can be retried." });
        return;
    }
    const extension = file.kind === "ifc" ? ".ifc" : ".e57";
    const inputPath = path.join(getProjectDirectory(projectId), "uploads", `${fileId}${extension}`);
    if (!fs.existsSync(inputPath)) {
        response.status(404).json({ error: "The original uploaded file is no longer available for retry." });
        return;
    }
    const revision = (file.revision ?? 0) + 1;
    const convertedDirectory = path.join(getProjectDirectory(projectId), "converted", fileId);
    fs.rmSync(convertedDirectory, { recursive: true, force: true });
    updateProject(projectId, (storedProject) => {
        const storedFile = storedProject.files.find((candidate) => candidate.id === fileId);
        if (!storedFile) return;
        storedFile.revision = revision;
        storedFile.status = "queued";
        delete storedFile.error;
        delete storedFile.model;
        delete storedFile.pointCloud;
        delete storedFile.panorama;
    });
    if (file.kind === "ifc") {
        queueIfcConversion(projectId, fileId, inputPath, revision);
    } else {
        queueE57Conversion(projectId, fileId, inputPath, revision);
    }
    response.status(202).json(readProjects().find(({ id }) => id === projectId));
});

app.post("/api/projects/:projectId/files/:fileId/cancel", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const fileId = String(request.params.fileId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    const file = project?.files.find((candidate) => candidate.id === fileId);
    if (!project || !file) {
        response.status(404).json({ error: "Project file not found." });
        return;
    }
    if (file.status !== "queued" && file.status !== "processing") {
        response.status(409).json({ error: "Only queued or running conversions can be cancelled." });
        return;
    }
    conversionControllers.get(conversionKey(projectId, fileId))?.abort();
    const updatedProject = updateProject(projectId, (storedProject) => {
        const storedFile = storedProject.files.find((candidate) => candidate.id === fileId);
        if (!storedFile) return;
        storedFile.status = "cancelled";
        delete storedFile.error;
        delete storedFile.model;
        delete storedFile.pointCloud;
        delete storedFile.panorama;
    });
    response.json(updatedProject);
});

app.delete("/api/projects/:projectId/files/:fileId", (request, response) => {
    const projectId = String(request.params.projectId ?? "");
    const fileId = String(request.params.fileId ?? "");
    const project = readProjects().find(({ id }) => id === projectId);
    if (!project) {
        response.status(404).json({ error: "Project not found." });
        return;
    }
    const file = project.files.find((candidate) => candidate.id === fileId);
    if (!file) {
        response.status(404).json({ error: "Project file not found." });
        return;
    }
    if (file.status === "queued" || file.status === "processing") {
        response.status(409).json({ error: "A file cannot be deleted while conversion is running." });
        return;
    }

    removeStoredFileAssets(projectId, fileId);
    const updatedProject = updateProject(projectId, (storedProject) => {
        storedProject.files = storedProject.files.filter((candidate) => candidate.id !== fileId);
    });
    response.json(updatedProject);
});

app.post(
    "/api/projects/:projectId/files/:fileId/replace",
    upload.single("file"),
    (request, response) => {
        const projectId = String(request.params.projectId ?? "");
        const fileId = String(request.params.fileId ?? "");
        const uploadedFile = request.file;
        const removeTemporaryUpload = () => {
            if (uploadedFile) fs.rmSync(uploadedFile.path, { force: true });
        };
        const project = readProjects().find(({ id }) => id === projectId);
        if (!project) {
            removeTemporaryUpload();
            response.status(404).json({ error: "Project not found." });
            return;
        }
        const file = project.files.find((candidate) => candidate.id === fileId);
        if (!file) {
            removeTemporaryUpload();
            response.status(404).json({ error: "Project file not found." });
            return;
        }
        if (file.status === "queued" || file.status === "processing") {
            removeTemporaryUpload();
            response.status(409).json({ error: "A file cannot be replaced while conversion is running." });
            return;
        }
        if (!uploadedFile) {
            response.status(400).json({ error: "Select one replacement file." });
            return;
        }

        const extension = path.extname(uploadedFile.originalname).toLowerCase();
        const replacementIsIfc = extension === ".ifc";
        const replacementIsE57 = extension === ".e57";
        const kindMatches = replacementIsIfc
            ? file.kind === "ifc"
            : replacementIsE57
                ? file.kind === "structured-e57"
                : file.kind === "point-cloud";
        if (!supportedFileExtensions.has(extension) || !kindMatches) {
            removeTemporaryUpload();
            response.status(400).json({
                error: file.kind === "ifc"
                    ? "An IFC model can only be replaced by an IFC file."
                    : file.kind === "structured-e57"
                        ? "A structured E57 can only be replaced by an E57 file."
                        : "A point cloud can only be replaced by a LAS or LAZ file.",
            });
            return;
        }

        const revision = (file.revision ?? 0) + 1;
        const uploadsDirectory = path.join(getProjectDirectory(projectId), "uploads");
        fs.mkdirSync(uploadsDirectory, { recursive: true });
        const inputPath = path.join(uploadsDirectory, `${fileId}${extension}`);
        removeStoredFileAssets(projectId, fileId);
        fs.renameSync(uploadedFile.path, inputPath);

        updateProject(projectId, (storedProject) => {
            const storedFile = storedProject.files.find((candidate) => candidate.id === fileId);
            if (!storedFile) return;
            storedFile.revision = revision;
            storedFile.originalName = uploadedFile.originalname;
            storedFile.status = replacementIsIfc || replacementIsE57 ? "queued" : "ready";
            delete storedFile.error;
            delete storedFile.model;
            delete storedFile.pointCloud;
            delete storedFile.panorama;
            if (!replacementIsIfc && !replacementIsE57) {
                storedFile.pointCloud = buildPointCloudPackage(
                    projectId,
                    fileId,
                    extension as ".las" | ".laz",
                    revision,
                    Boolean(project.sceneOrigin),
                );
                if (project.sceneOrigin) {
                    createLocallyRebasedPointCloud(
                        projectId,
                        fileId,
                        extension as ".las" | ".laz",
                        project.sceneOrigin,
                    );
                }
            }
        });
        if (replacementIsIfc) {
            queueIfcConversion(projectId, fileId, inputPath, revision);
        } else if (replacementIsE57) {
            queueE57Conversion(projectId, fileId, inputPath, revision);
        }
        response.status(202).json(readProjects().find(({ id }) => id === projectId));
    },
);

app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (response.headersSent) {
        next(error);
        return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        response.status(413).json({ error: "The selected file exceeds the 20 GB upload limit." });
        return;
    }
    if (error instanceof multer.MulterError) {
        response.status(400).json({ error: `Upload failed: ${error.message}` });
        return;
    }

    console.error("Unhandled request error", error);
    response.status(500).json({ error: "The upload or conversion request failed. Check the converter server log for details." });
});

app.listen(port, () => {
    console.log(`SymetrIQ project server listening on http://localhost:${port}`);
});
