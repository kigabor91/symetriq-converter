import type * as WebIFCModule from "web-ifc";

export interface CoordinateReference {
    /** Project Base Point / world origin used to locally rebase geometry, in metres. */
    origin: [number, number, number];
}

type WebIFC = typeof WebIFCModule;
type IFCLine = Record<string, unknown>;

function valueOf(value: unknown): unknown {
    return value && typeof value === "object" && "value" in value
        ? (value as { value: unknown }).value
        : value;
}

function lineIdOf(value: unknown): number | undefined {
    const unwrapped = valueOf(value);
    return typeof unwrapped === "number" ? unwrapped : undefined;
}

function typeOf(line: IFCLine): string {
    return (line as { __proto__?: { constructor?: { name?: string } } }).__proto__
        ?.constructor?.name ?? "";
}

function coordinatesOf(line: IFCLine): number[] | undefined {
    const coordinates = valueOf(line.Coordinates ?? line.DirectionRatios);
    if (!Array.isArray(coordinates)) return undefined;
    const values = coordinates.map(valueOf);
    return values.every((value) => typeof value === "number")
        ? values as number[]
        : undefined;
}

function getLengthUnitScale(ifcApi: InstanceType<WebIFC["IfcAPI"]>, modelId: number): number {
    const lineIds = ifcApi.GetAllLines(modelId);

    // IFC files may contain several unit assignments. Use the one referenced
    // by IfcProject rather than the first LENGTHUNIT encountered in the file.
    for (let index = 0; index < lineIds.size(); index++) {
        const line = ifcApi.GetLine(modelId, lineIds.get(index)) as IFCLine;
        if (typeOf(line) !== "IfcProject") continue;
        const assignmentId = lineIdOf(line.UnitsInContext);
        if (assignmentId === undefined) break;
        const assignment = ifcApi.GetLine(modelId, assignmentId) as IFCLine;
        const units = valueOf(assignment.Units);
        const unitIds = Array.isArray(units)
            ? units.map(lineIdOf).filter((id): id is number => id !== undefined)
            : [];
        for (const unitId of unitIds) {
            const unit = ifcApi.GetLine(modelId, unitId) as IFCLine;
            if (typeOf(unit) !== "IfcSIUnit" || valueOf(unit.UnitType) !== "LENGTHUNIT") continue;
            const prefix = valueOf(unit.Prefix);
            return prefix === "MILLI" ? 0.001 : prefix === "CENTI" ? 0.01 : 1;
        }
        break;
    }
    return 1;
}

/**
 * Resolves the translation of an IfcLocalPlacement chain. Revit's Shared
 * Coordinates export places the survey reference on IfcSite, while the
 * geometric representation context itself commonly remains at 0,0,0.
 */
function getLocalPlacementOrigin(
    ifcApi: InstanceType<WebIFC["IfcAPI"]>,
    modelId: number,
    placementId: number,
): number[] | undefined {
    const origin = [0, 0, 0];
    const visited = new Set<number>();
    let currentPlacementId: number | undefined = placementId;

    while (currentPlacementId !== undefined && !visited.has(currentPlacementId)) {
        visited.add(currentPlacementId);
        const placement = ifcApi.GetLine(modelId, currentPlacementId) as IFCLine;
        if (typeOf(placement) !== "IfcLocalPlacement") break;

        const relativePlacementId = lineIdOf(placement.RelativePlacement);
        if (relativePlacementId !== undefined) {
            const relativePlacement = ifcApi.GetLine(modelId, relativePlacementId) as IFCLine;
            const locationId = lineIdOf(relativePlacement.Location);
            if (locationId !== undefined) {
                const location = ifcApi.GetLine(modelId, locationId) as IFCLine;
                const coordinates = coordinatesOf(location);
                if (coordinates) {
                    origin[0] = origin[0]! + (coordinates[0] ?? 0);
                    origin[1] = origin[1]! + (coordinates[1] ?? 0);
                    origin[2] = origin[2]! + (coordinates[2] ?? 0);
                }
            }
        }
        currentPlacementId = lineIdOf(placement.PlacementRelTo);
    }

    return origin;
}

/** Reads IFC's WorldCoordinateSystem origin, normalized to metres. */
export async function extractCoordinateReference(
    WebIFC: WebIFC,
    sourceData: Uint8Array,
): Promise<CoordinateReference | undefined> {
    const ifcApi = new WebIFC.IfcAPI();
    await ifcApi.Init();
    const modelId = ifcApi.OpenModel(sourceData);

    try {
        const unitScale = getLengthUnitScale(ifcApi, modelId);
        const lineIds = ifcApi.GetAllLines(modelId);

        // Revit's "Shared Coordinates" IFC export stores the actual survey
        // origin on IfcSite. Prefer it over WCS, which is usually 0,0,0 even
        // when the model is correctly georeferenced.
        for (let index = 0; index < lineIds.size(); index++) {
            const site = ifcApi.GetLine(modelId, lineIds.get(index)) as IFCLine;
            if (typeOf(site) !== "IfcSite") continue;
            const placementId = lineIdOf(site.ObjectPlacement);
            if (placementId === undefined) continue;
            const coordinates = getLocalPlacementOrigin(ifcApi, modelId, placementId);
            if (!coordinates || coordinates.length < 3) continue;
            return {
                origin: [
                    coordinates[0]! * unitScale,
                    coordinates[1]! * unitScale,
                    coordinates[2]! * unitScale,
                ],
            };
        }

        // Fallback for IFCs that store their project base point directly on
        // the representation context instead of the site placement.
        for (let index = 0; index < lineIds.size(); index++) {
            const context = ifcApi.GetLine(modelId, lineIds.get(index)) as IFCLine;
            if (typeOf(context) !== "IfcGeometricRepresentationContext") continue;
            const placementId = lineIdOf(context.WorldCoordinateSystem);
            if (placementId === undefined) continue;
            const placement = ifcApi.GetLine(modelId, placementId) as IFCLine;
            const locationId = lineIdOf(placement.Location);
            if (locationId === undefined) continue;
            const location = ifcApi.GetLine(modelId, locationId) as IFCLine;
            const coordinates = coordinatesOf(location);
            if (!coordinates || coordinates.length < 3) continue;
            return {
                origin: [
                    coordinates[0]! * unitScale,
                    coordinates[1]! * unitScale,
                    coordinates[2]! * unitScale,
                ],
            };
        }
        return undefined;
    } finally {
        ifcApi.CloseModel(modelId);
    }
}
