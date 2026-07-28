import * as fs from "node:fs";
import * as path from "node:path";

export type ProjectFileKind = "ifc" | "point-cloud" | "structured-e57";
export type ProjectFileStatus = "queued" | "processing" | "ready" | "error" | "cancelled";

export interface StoredModelPackage {
    id: string;
    geometry: { format: "xkt"; src: string };
    metadata: { format: "json"; src: string };
    coordinateReference?: { origin: [number, number, number] };
    transform?: { position?: [number, number, number] };
}

export interface StoredPointCloudPackage {
    id: string;
    source: { format: "las" | "laz"; src: string };
    pointStride: number;
    /** Pre-sampled point clouds keyed by displayed detail level (for example "50"). */
    lodSources?: Record<string, { format: "las" | "laz"; src: string }>;
    /** Maps local LAS East/North/Up coordinates to the IFC/XKT render axes. */
    lasTransform?: number[];
}

export interface StoredPanoramaStation {
    id: string;
    name: string;
    sourceData3DGuid: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    faces: string[];
}

export interface StoredPanoramaPackage {
    stations: StoredPanoramaStation[];
}

export interface ProjectFileRecord {
    id: string;
    revision?: number;
    originalName: string;
    kind: ProjectFileKind;
    status: ProjectFileStatus;
    error?: string;
    model?: StoredModelPackage;
    pointCloud?: StoredPointCloudPackage;
    panorama?: StoredPanoramaPackage;
}

export interface ProjectIssueSelectionRecord {
    modelId: string;
    rendererObjectId: string;
    globalId?: string;
    type?: string;
    name?: string;
}

export type ProjectIssueStatus = "open" | "resolved" | "closed";

export interface ProjectIssueCommentRecord {
    id: string;
    authorName: string;
    body: string;
    createdAt: string;
}

export interface ProjectPropertyViewRecord {
    id: string;
    name: string;
    propertyKeys: string[];
    createdAt: string;
}

export interface ProjectDisplayViewRecord {
    id: string;
    name: string;
    mode: "shaded" | "xray";
    opacity: number;
    colorOverride?: { propertyKey: string; values: string[]; color: string };
    createdAt: string;
}

export interface ProjectIssueRecord {
    id: string;
    title: string;
    description: string;
    status: ProjectIssueStatus;
    createdAt: string;
    updatedAt: string;
    screenshotSrc: string;
    viewpoint: Record<string, unknown>;
    packageVisibility: Record<string, boolean>;
    selection?: ProjectIssueSelectionRecord;
    category?: string;
    comments?: ProjectIssueCommentRecord[];
}

export interface ProjectRecord {
    id: string;
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    files: ProjectFileRecord[];
    /** Shared source-coordinate origin used to locally rebase large point clouds. */
    sceneOrigin?: [number, number, number];
    issues?: ProjectIssueRecord[];
    propertyViews?: ProjectPropertyViewRecord[];
    displayViews?: ProjectDisplayViewRecord[];
    /** IFC model whose extracted storeys define plan-view levels. */
    planReferenceModelId?: string;
    /** Metres relative to the selected reference level. */
    planViewRange?: { lower: number; cut: number; upper: number };
}

const dataDirectory = path.resolve("./data");
const projectsFile = path.join(dataDirectory, "projects.json");

export function getDataDirectory(): string {
    return dataDirectory;
}

export function getProjectDirectory(projectId: string): string {
    return path.join(dataDirectory, "projects", projectId);
}

export function readProjects(): ProjectRecord[] {
    fs.mkdirSync(dataDirectory, { recursive: true });
    if (!fs.existsSync(projectsFile)) {
        return [];
    }
    return JSON.parse(fs.readFileSync(projectsFile, "utf8")) as ProjectRecord[];
}

export function writeProjects(projects: ProjectRecord[]): void {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const temporaryPath = `${projectsFile}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(projects, null, 2));
    fs.renameSync(temporaryPath, projectsFile);
}

export function updateProject(
    projectId: string,
    update: (project: ProjectRecord) => void,
): ProjectRecord | undefined {
    const projects = readProjects();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) {
        return undefined;
    }
    update(project);
    project.updatedAt = new Date().toISOString();
    writeProjects(projects);
    return project;
}
