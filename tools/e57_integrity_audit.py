"""Read-only E57 to LAS spatial-integrity audit for production fixtures.

This deliberately shares the production worker's transform, millimetre hash
sampling and LAS decoding rules, but never writes or changes conversion output.
It keeps only one E57 scan in memory at a time.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "e57_runtime"))
sys.path.insert(0, str(ROOT / "src"))

import numpy as np
import pye57
from e57_worker import FAST_POINT_DIVISOR, SCALE, VERY_FAST_POINT_DIVISOR, choose_las_offsets


def sample_mask(coordinates: np.ndarray, divisor: int) -> np.ndarray:
    """Vectorised equivalent of e57_worker.spatial_sample for finite points."""
    millimetres = np.rint(coordinates * 1000).astype(np.int64)
    hashed = (
        (millimetres[:, 0] * 73856093)
        ^ (millimetres[:, 1] * 19349663)
        ^ (millimetres[:, 2] * 83492791)
    )
    return ((hashed & 0x7FFFFFFF) % divisor) == 0


def las_header(path: Path) -> dict:
    with path.open("rb") as handle:
        header = handle.read(227)
    if header[:4] != b"LASF":
        raise ValueError(f"Not a LAS file: {path}")
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "version": f"{header[24]}.{header[25]}",
        "point_data_offset": struct.unpack_from("<I", header, 96)[0],
        "point_format": header[104],
        "point_record_length": struct.unpack_from("<H", header, 105)[0],
        "point_count": struct.unpack_from("<I", header, 107)[0],
        "scale": list(struct.unpack_from("<3d", header, 131)),
        "offset": list(struct.unpack_from("<3d", header, 155)),
        "bounds": {
            "minimum": [struct.unpack_from("<d", header, offset)[0] for offset in (187, 203, 219)],
            "maximum": [struct.unpack_from("<d", header, offset)[0] for offset in (179, 195, 211)],
        },
    }


def voxel_keys(coordinates: np.ndarray, minimum: np.ndarray, dimensions: np.ndarray, voxel_size: float) -> set[int]:
    index = np.floor((coordinates - minimum) / voxel_size).astype(np.int64)
    index = np.maximum(index, 0)
    index = np.minimum(index, dimensions - 1)
    keys = index[:, 0] + dimensions[0] * (index[:, 1] + dimensions[1] * index[:, 2])
    return {int(value) for value in np.unique(keys)}


def read_las_voxels(header: dict, minimum: np.ndarray, dimensions: np.ndarray, voxel_size: float) -> tuple[set[int], np.ndarray, np.ndarray, int]:
    path = Path(header["path"])
    point_count = int(header["point_count"])
    record_length = int(header["point_record_length"])
    if record_length < 12:
        raise ValueError(f"Unsupported LAS record length: {record_length}")
    dtype = np.dtype({"names": ["x", "y", "z"], "formats": ["<i4", "<i4", "<i4"], "offsets": [0, 4, 8], "itemsize": record_length})
    voxels: set[int] = set()
    actual_minimum = np.array([np.inf, np.inf, np.inf], dtype=np.float64)
    actual_maximum = np.array([-np.inf, -np.inf, -np.inf], dtype=np.float64)
    with path.open("rb") as handle:
        handle.seek(int(header["point_data_offset"]))
        remaining = point_count
        while remaining:
            batch = min(remaining, 1_000_000)
            buffer = handle.read(batch * record_length)
            if len(buffer) != batch * record_length:
                raise ValueError(f"Unexpected LAS EOF after {point_count - remaining} records: {path}")
            records = np.frombuffer(buffer, dtype=dtype, count=batch)
            coordinates = np.column_stack((records["x"], records["y"], records["z"])).astype(np.float64)
            coordinates = coordinates * np.asarray(header["scale"], dtype=np.float64) + np.asarray(header["offset"], dtype=np.float64)
            actual_minimum = np.minimum(actual_minimum, coordinates.min(axis=0))
            actual_maximum = np.maximum(actual_maximum, coordinates.max(axis=0))
            voxels.update(voxel_keys(coordinates, minimum, dimensions, voxel_size))
            remaining -= batch
    return voxels, actual_minimum, actual_maximum, point_count


def source_bounds(e57: pye57.E57, origin: np.ndarray) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    global_minimum = np.array([np.inf, np.inf, np.inf], dtype=np.float64)
    global_maximum = np.array([-np.inf, -np.inf, -np.inf], dtype=np.float64)
    scan_rows: list[dict] = []
    for index in range(e57.scan_count):
        header = e57.get_header(index)
        declared = int(header.point_count)
        row = {"scan_index": index, "declared_points": declared, "valid_points": 0, "rgb": False}
        if declared <= 0:
            row["status"] = "skipped-empty-header"
            scan_rows.append(row)
            continue
        scan = e57.read_scan(index, colors=True, transform=True, ignore_missing_fields=True)
        coordinates = np.column_stack((scan["cartesianX"], scan["cartesianY"], scan["cartesianZ"])) - origin
        finite = np.all(np.isfinite(coordinates), axis=1)
        coordinates = coordinates[finite]
        row["valid_points"] = int(len(coordinates))
        row["invalid_or_unreadable_points"] = declared - int(len(coordinates))
        row["rgb"] = all(channel in scan for channel in ("colorRed", "colorGreen", "colorBlue"))
        row["source_id"] = str(getattr(header, "guid", "unknown"))
        if len(coordinates):
            minimum = coordinates.min(axis=0)
            maximum = coordinates.max(axis=0)
            row["bounds"] = {"minimum": minimum.tolist(), "maximum": maximum.tolist()}
            global_minimum = np.minimum(global_minimum, minimum)
            global_maximum = np.maximum(global_maximum, maximum)
        else:
            row["status"] = "no-finite-points"
        scan_rows.append(row)
        print(f"[E57 audit] bounds scan={index} valid={row['valid_points']}", file=sys.stderr, flush=True)
    return global_minimum, global_maximum, scan_rows


def source_sampling_and_voxels(
    e57: pye57.E57,
    origin: np.ndarray,
    minimum: np.ndarray,
    dimensions: np.ndarray,
    voxel_size: float,
    scan_rows: list[dict],
) -> tuple[set[int], set[int], set[int], dict[int, tuple[set[int], set[int]]]]:
    source_voxels: set[int] = set()
    fast_voxels: set[int] = set()
    very_fast_voxels: set[int] = set()
    per_scan_sample_voxels: dict[int, tuple[set[int], set[int]]] = {}
    for row in scan_rows:
        index = int(row["scan_index"])
        if int(row["declared_points"]) <= 0:
            row["expected_fast_points"] = 0
            row["expected_very_fast_points"] = 0
            per_scan_sample_voxels[index] = (set(), set())
            continue
        scan = e57.read_scan(index, transform=True, ignore_missing_fields=True)
        coordinates = np.column_stack((scan["cartesianX"], scan["cartesianY"], scan["cartesianZ"])) - origin
        coordinates = coordinates[np.all(np.isfinite(coordinates), axis=1)]
        fast = sample_mask(coordinates, FAST_POINT_DIVISOR)
        very_fast = sample_mask(coordinates, VERY_FAST_POINT_DIVISOR)
        row["expected_fast_points"] = int(fast.sum())
        row["expected_very_fast_points"] = int(very_fast.sum())
        row["fast_retention"] = float(fast.mean()) if len(fast) else 0.0
        row["very_fast_retention"] = float(very_fast.mean()) if len(very_fast) else 0.0
        source_voxels.update(voxel_keys(coordinates, minimum, dimensions, voxel_size))
        scan_fast_voxels = voxel_keys(coordinates[fast], minimum, dimensions, voxel_size)
        scan_very_fast_voxels = voxel_keys(coordinates[very_fast], minimum, dimensions, voxel_size)
        fast_voxels.update(scan_fast_voxels)
        very_fast_voxels.update(scan_very_fast_voxels)
        per_scan_sample_voxels[index] = (scan_fast_voxels, scan_very_fast_voxels)
        print(f"[E57 audit] sample scan={index} fast={row['expected_fast_points']} veryFast={row['expected_very_fast_points']}", file=sys.stderr, flush=True)
    return source_voxels, fast_voxels, very_fast_voxels, per_scan_sample_voxels


def coverage(expected: set[int], actual: set[int]) -> dict:
    missing = expected - actual
    unexpected = actual - expected
    return {
        "expected_occupied_voxels": len(expected),
        "actual_occupied_voxels": len(actual),
        "missing_expected_voxels": len(missing),
        "unexpected_output_voxels": len(unexpected),
        "expected_voxel_coverage": (len(expected & actual) / len(expected)) if expected else 1.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_e57", type=Path)
    parser.add_argument("fast_las", type=Path)
    parser.add_argument("very_fast_las", type=Path)
    parser.add_argument("--scene-origin", nargs=3, type=float, default=(0.0, 0.0, 0.0))
    parser.add_argument("--voxel-size", type=float, default=5.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.voxel_size <= 0:
        raise ValueError("voxel size must be positive")

    origin = np.asarray(args.scene_origin, dtype=np.float64)
    fast_header = las_header(args.fast_las)
    very_fast_header = las_header(args.very_fast_las)
    with pye57.E57(str(args.input_e57)) as e57:
        minimum, maximum, scan_rows = source_bounds(e57, origin)
        if not np.all(np.isfinite(minimum)):
            minimum = np.zeros(3, dtype=np.float64)
            maximum = np.zeros(3, dtype=np.float64)
        dimensions = np.maximum(np.ceil((maximum - minimum) / args.voxel_size).astype(np.int64) + 1, 1)
        source_voxels, expected_fast_voxels, expected_very_fast_voxels, per_scan_sample_voxels = source_sampling_and_voxels(
            e57, origin, minimum, dimensions, args.voxel_size, scan_rows,
        )

    actual_fast_voxels, fast_minimum, fast_maximum, fast_count = read_las_voxels(
        fast_header, minimum, dimensions, args.voxel_size,
    )
    actual_very_fast_voxels, very_fast_minimum, very_fast_maximum, very_fast_count = read_las_voxels(
        very_fast_header, minimum, dimensions, args.voxel_size,
    )
    expected_fast_count = sum(int(row.get("expected_fast_points", 0)) for row in scan_rows)
    expected_very_fast_count = sum(int(row.get("expected_very_fast_points", 0)) for row in scan_rows)
    for row in scan_rows:
        scan_fast_voxels, scan_very_fast_voxels = per_scan_sample_voxels[int(row["scan_index"])]
        row["expected_fast_occupied_voxels"] = len(scan_fast_voxels)
        row["missing_fast_occupied_voxels_in_output"] = len(scan_fast_voxels - actual_fast_voxels)
        row["expected_very_fast_occupied_voxels"] = len(scan_very_fast_voxels)
        row["missing_very_fast_occupied_voxels_in_output"] = len(scan_very_fast_voxels - actual_very_fast_voxels)
    valid_count = sum(int(row["valid_points"]) for row in scan_rows)
    report = {
        "input": {"path": str(args.input_e57), "bytes": args.input_e57.stat().st_size, "scan_count": len(scan_rows)},
        "scene_origin": origin.tolist(),
        "current_worker_selected_las_offsets": choose_las_offsets(minimum, maximum).tolist(),
        "sampling": {"strategy": "millimetre-coordinate hash", "fast_divisor": FAST_POINT_DIVISOR, "very_fast_divisor": VERY_FAST_POINT_DIVISOR},
        "source": {
            "valid_points": valid_count,
            "bounds": {"minimum": minimum.tolist(), "maximum": maximum.tolist()},
            "occupied_voxels": len(source_voxels),
        },
        "outputs": {
            "fast": {
                "header": fast_header,
                "actual_point_count": fast_count,
                "expected_point_count": expected_fast_count,
                "actual_bounds": {"minimum": fast_minimum.tolist(), "maximum": fast_maximum.tolist()},
                "coverage_against_expected_sample": coverage(expected_fast_voxels, actual_fast_voxels),
                "coverage_against_source": coverage(source_voxels, actual_fast_voxels),
            },
            "very_fast": {
                "header": very_fast_header,
                "actual_point_count": very_fast_count,
                "expected_point_count": expected_very_fast_count,
                "actual_bounds": {"minimum": very_fast_minimum.tolist(), "maximum": very_fast_maximum.tolist()},
                "coverage_against_expected_sample": coverage(expected_very_fast_voxels, actual_very_fast_voxels),
                "coverage_against_source": coverage(source_voxels, actual_very_fast_voxels),
            },
        },
        "scans": scan_rows,
    }
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "valid_points": valid_count, "fast": fast_count, "very_fast": very_fast_count}))


if __name__ == "__main__":
    main()
