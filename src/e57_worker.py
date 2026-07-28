"""Extracts Leica structured E57 data into viewer-ready LAS and JPEG cubemap faces."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
import os
import struct
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools" / "e57_runtime"
sys.path.insert(0, str(TOOLS))

import numpy as np
import pye57

LAS_HEADER_SIZE = 227
POINT_RECORD_LENGTH = 26  # LAS 1.2 point format 2: XYZ, intensity, flags, RGB
SCALE = 0.001
# Keep this switch rather than deleting the implementation. Balanced creates
# the largest derived file and is too GPU-intensive for the current MVP viewer.
GENERATE_BALANCED_LOD = False
BALANCED_POINT_DIVISOR = 10
FAST_POINT_DIVISOR = 50
VERY_FAST_POINT_DIVISOR = 80


def read_optional(node, name, default=None):
    return node[name].value() if node.isDefined(name) else default


def write_las_header(handle, point_count: int) -> None:
    header = bytearray(LAS_HEADER_SIZE)
    header[0:4] = b"LASF"
    header[24] = 1
    header[25] = 2
    # Slice assignment must keep the fixed LAS field width. Assigning a
    # shorter byte string would shrink the bytearray and shift point records.
    header[26:58] = b"SymetrIQ E57 converter".ljust(32, b"\0")
    header[58:90] = b"SymetrIQ".ljust(32, b"\0")
    struct.pack_into("<H", header, 90, 1)
    struct.pack_into("<H", header, 92, 2026)
    struct.pack_into("<H", header, 94, LAS_HEADER_SIZE)
    struct.pack_into("<I", header, 96, LAS_HEADER_SIZE)
    header[104] = 2
    struct.pack_into("<H", header, 105, POINT_RECORD_LENGTH)
    struct.pack_into("<I", header, 107, point_count)
    struct.pack_into("<5I", header, 111, point_count, 0, 0, 0, 0)
    struct.pack_into("<3d", header, 131, SCALE, SCALE, SCALE)
    struct.pack_into("<3d", header, 155, 0.0, 0.0, 0.0)
    handle.write(header)


def write_las_bounds(handle, minimum: np.ndarray, maximum: np.ndarray) -> None:
    """Updates the LAS 1.2 public-header bounds after point streaming.

    xeokit's LAS loader uses these values when calculating the scene bounds,
    so leaving them at zero makes a valid local-coordinate cloud look as if
    it were spatially invalid.
    """
    handle.seek(179)
    handle.write(struct.pack(
        "<6d",
        float(maximum[0]), float(minimum[0]),
        float(maximum[1]), float(minimum[1]),
        float(maximum[2]), float(minimum[2]),
    ))


def finalize_las(handle, point_count: int, minimum: np.ndarray, maximum: np.ndarray) -> None:
    """Writes the final count and bounds for a streamed LAS file."""
    handle.seek(107)
    handle.write(struct.pack("<I", point_count))
    handle.write(struct.pack("<5I", point_count, 0, 0, 0, 0))
    write_las_bounds(handle, minimum, maximum)


def spatial_sample(px: float, py: float, pz: float, divisor: int) -> bool:
    """Deterministically selects points across space, never by scan order.

    Structured E57 points are usually ordered by scanner row / column. Taking
    every Nth record therefore creates visible stripes. Hashing millimetre
    coordinates creates a stable, evenly distributed subset instead.
    """
    x = round(px * 1000)
    y = round(py * 1000)
    z = round(pz * 1000)
    hashed = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791)
    return (hashed & 0x7FFFFFFF) % divisor == 0


def pack_las_point(px, py, pz, pr, pg, pb) -> bytes:
    return struct.pack(
        "<iiiHBBbBHHHH",
        round(float(px) / SCALE), round(float(py) / SCALE), round(float(pz) / SCALE),
        0, 0, 0, 0, 0, 0, int(pr) * 257, int(pg) * 257, int(pb) * 257,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output_directory")
    parser.add_argument("file_id")
    parser.add_argument("--scene-origin", nargs=3, type=float)
    args = parser.parse_args()
    origin = np.array(args.scene_origin or [0.0, 0.0, 0.0])
    output = Path(args.output_directory)
    output.mkdir(parents=True, exist_ok=True)
    panorama_root = output / "panoramas"
    panorama_root.mkdir(exist_ok=True)

    with pye57.E57(args.input) as e57:
        headers = [e57.get_header(index) for index in range(e57.scan_count)]
        point_count = sum(header.point_count for header in headers)
        output_paths = {
            "fast": output / f"{args.file_id}.fast.las",
            "very_fast": output / f"{args.file_id}.very-fast.las",
        }
        # Re-enable this one line when a future streamed point-cloud renderer
        # can make the denser 1/10 LOD useful again.
        if GENERATE_BALANCED_LOD:
            output_paths["balanced"] = output / f"{args.file_id}.balanced.las"
        with ExitStack() as stack:
            writers = {name: stack.enter_context(path.open("wb")) for name, path in output_paths.items()}
            for writer in writers.values():
                write_las_header(writer, 0)
            counts = {name: 0 for name in writers}
            converted_point_count = 0
            minimums = {name: np.array([np.inf, np.inf, np.inf]) for name in writers}
            maximums = {name: np.array([-np.inf, -np.inf, -np.inf]) for name in writers}
            for scan_index in range(e57.scan_count):
                # Leica/Register 360 exports may include an empty images2D/
                # data3D entry before the real scanner stations. libE57 raises
                # ErrorInternal when asked to open that zero-point packet, so
                # skip it instead of failing the entire structured E57 import.
                if headers[scan_index].point_count <= 0:
                    continue
                scan = e57.read_scan(scan_index, colors=True, transform=True, ignore_missing_fields=True)
                x = scan["cartesianX"] - origin[0]
                y = scan["cartesianY"] - origin[1]
                z = scan["cartesianZ"] - origin[2]
                red = scan.get("colorRed", np.zeros(len(x), dtype=np.uint8))
                green = scan.get("colorGreen", np.zeros(len(x), dtype=np.uint8))
                blue = scan.get("colorBlue", np.zeros(len(x), dtype=np.uint8))
                for values in zip(x, y, z, red, green, blue):
                    px, py, pz, pr, pg, pb = values
                    point = np.array([float(px), float(py), float(pz)])
                    record = pack_las_point(px, py, pz, pr, pg, pb)
                    converted_point_count += 1
                    if GENERATE_BALANCED_LOD and spatial_sample(
                        float(px), float(py), float(pz), BALANCED_POINT_DIVISOR,
                    ):
                        writers["balanced"].write(record)
                        counts["balanced"] += 1
                        minimums["balanced"] = np.minimum(minimums["balanced"], point)
                        maximums["balanced"] = np.maximum(maximums["balanced"], point)
                    if spatial_sample(float(px), float(py), float(pz), FAST_POINT_DIVISOR):
                        writers["fast"].write(record)
                        counts["fast"] += 1
                        minimums["fast"] = np.minimum(minimums["fast"], point)
                        maximums["fast"] = np.maximum(maximums["fast"], point)
                    if spatial_sample(float(px), float(py), float(pz), VERY_FAST_POINT_DIVISOR):
                        writers["very_fast"].write(record)
                        counts["very_fast"] += 1
                        minimums["very_fast"] = np.minimum(minimums["very_fast"], point)
                        maximums["very_fast"] = np.maximum(maximums["very_fast"], point)
            for name, writer in writers.items():
                finalize_las(writer, counts[name], minimums[name], maximums[name])

        stations = {}
        images = e57.root["images2D"] if e57.root.isDefined("images2D") else []
        for image_index, image in enumerate(images):
            if not image.isDefined("associatedData3DGuid") or not image.isDefined("pinholeRepresentation"):
                continue
            representation = image["pinholeRepresentation"]
            if not representation.isDefined("jpegImage"):
                continue
            data_guid = image["associatedData3DGuid"].value()
            station = stations.setdefault(data_guid, {
                "id": data_guid,
                "name": read_optional(image, "name", data_guid),
                "sourceData3DGuid": data_guid,
                "position": [0.0, 0.0, 0.0],
                "rotation": [1.0, 0.0, 0.0, 0.0],
                "faces": [],
            })
            if image.isDefined("pose"):
                pose = image["pose"]
                translation = pose["translation"]
                # E57/LAS uses East/North/Up. The IFC GLB/XKT route uses
                # East/Up/-North, which is also the coordinate space used by
                # the panorama layer in the browser.
                east = float(translation["x"].value() - origin[0])
                north = float(translation["y"].value() - origin[1])
                up = float(translation["z"].value() - origin[2])
                station["position"] = [east, up, -north]
                rotation = pose["rotation"]
                station["rotation"] = [float(component.value()) for component in rotation]
            station_directory = panorama_root / data_guid
            station_directory.mkdir(exist_ok=True)
            face_name = f"face-{len(station['faces'])}.jpg"
            face_path = station_directory / face_name
            face_path.write_bytes(bytes(representation["jpegImage"].read_buffer()))
            station["faces"].append(f"panoramas/{data_guid}/{face_name}")

    print(json.dumps({"pointCount": converted_point_count, "panorama": {"stations": list(stations.values())}}))


if __name__ == "__main__":
    main()
