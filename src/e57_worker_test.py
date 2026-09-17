import io
import struct
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "e57_runtime"))

import numpy as np

from e57_worker import INT32_MAX, INT32_MIN, SCALE, choose_las_offsets, pack_las_point, write_las_header


def decode_xyz(record: bytes, offsets) -> np.ndarray:
    encoded = struct.unpack_from("<3i", record)
    return np.array(encoded, dtype=np.float64) * SCALE + np.asarray(offsets, dtype=np.float64)


class LasCoordinateEncodingTests(unittest.TestCase):
    def test_local_coordinates_keep_zero_offset_and_round_trip(self):
        points = np.array([-12.345, 0.125, 48.901])
        offsets = choose_las_offsets(points - 0.001, points + 0.001)
        self.assertTrue(np.all(offsets == 0.0))
        decoded = decode_xyz(pack_las_point(*points, 1, 2, 3, offsets), offsets)
        self.assertTrue(np.all(np.abs(decoded - points) <= SCALE / 2.0))

    def test_large_georeferenced_coordinates_use_header_offsets(self):
        points = np.array([2_500_000.125, 1_900_000.875, -2_400_000.25])
        offsets = choose_las_offsets(points - 100.0, points + 100.0)
        self.assertTrue(np.any(offsets != 0.0))
        encoded_record = pack_las_point(*points, 1, 2, 3, offsets, scan_index=7, point_index=11)
        encoded = struct.unpack_from("<3i", encoded_record)
        self.assertTrue(all(INT32_MIN <= value <= INT32_MAX for value in encoded))
        decoded = decode_xyz(encoded_record, offsets)
        self.assertTrue(np.all(np.abs(decoded - points) <= SCALE / 2.0))

    def test_negative_coordinates_round_trip(self):
        points = np.array([-650_000.125, -238_000.875, -104.25])
        offsets = choose_las_offsets(points - 10.0, points + 10.0)
        decoded = decode_xyz(pack_las_point(*points, 1, 2, 3, offsets), offsets)
        self.assertTrue(np.all(np.abs(decoded - points) <= SCALE / 2.0))

    def test_int32_boundaries_are_safe(self):
        points = np.array([INT32_MIN * SCALE, INT32_MAX * SCALE, 0.0])
        record = pack_las_point(*points, 1, 2, 3)
        self.assertEqual(struct.unpack_from("<3i", record), (INT32_MIN, INT32_MAX, 0))

    def test_las_header_persists_scale_and_offsets(self):
        offsets = np.array([2_500_000.0, -1_900_000.0, 104.5])
        handle = io.BytesIO()
        write_las_header(handle, 0, offsets)
        header = handle.getvalue()
        self.assertEqual(struct.unpack_from("<3d", header, 131), (SCALE, SCALE, SCALE))
        self.assertEqual(struct.unpack_from("<3d", header, 155), tuple(offsets))

    def test_unrepresentable_axis_range_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "axis=Y.*scale=0.001"):
            choose_las_offsets(np.array([0.0, -3_000_000.0, 0.0]), np.array([0.0, 3_000_000.0, 0.0]))

    def test_overflow_has_coordinate_diagnostics_and_is_not_clamped(self):
        with self.assertRaisesRegex(ValueError, "axis=X.*source_coordinate=3000000.*scale=0.001.*offset=0.0.*encoded_integer=3000000000.*scan_index=4.*point_index=9"):
            pack_las_point(3_000_000.0, 0.0, 0.0, 1, 2, 3, (0.0, 0.0, 0.0), 4, 9)


if __name__ == "__main__":
    unittest.main()
