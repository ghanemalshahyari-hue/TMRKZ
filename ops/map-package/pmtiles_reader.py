#!/usr/bin/env python3
"""A minimal, read-only PMTiles v3 reader (standard library only) for the map-package tools: the header, the metadata,
every directory entry and single tiles. It never executes or interprets tile content. Only the internal compressions
"none" and "gzip" are supported; anything else is reported as unreadable rather than guessed.

Format: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
"""
from __future__ import annotations

import gzip
import json
import struct
from dataclasses import dataclass
from pathlib import Path

HEADER_LEN = 127
TILE_TYPES = {0: "unknown", 1: "mvt", 2: "png", 3: "jpeg", 4: "webp", 5: "avif"}
COMPRESSIONS = {0: "unknown", 1: "none", 2: "gzip", 3: "brotli", 4: "zstd"}
MAX_DIRECTORY_BYTES = 64 * 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024 * 1024


class PMTilesError(ValueError):
    pass


@dataclass(frozen=True)
class Header:
    version: int
    root_offset: int
    root_length: int
    metadata_offset: int
    metadata_length: int
    leaf_offset: int
    leaf_length: int
    data_offset: int
    data_length: int
    addressed_tiles: int
    tile_entries: int
    tile_contents: int
    clustered: bool
    internal_compression: str
    tile_compression: str
    tile_type: str
    min_zoom: int
    max_zoom: int
    bounds: tuple[float, float, float, float]
    center: tuple[float, float, int]


def zxy_to_tileid(z: int, x: int, y: int) -> int:
    """Tile id on the PMTiles Hilbert curve: all tiles of lower zooms first, then the Hilbert index at zoom z."""
    if z > 31 or x >= 1 << z or y >= 1 << z or x < 0 or y < 0:
        raise PMTilesError(f"tile {z}/{x}/{y} outside the zoom's grid")
    acc = ((1 << (2 * z)) - 1) // 3
    n = 1 << z
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = n - 1 - x, n - 1 - y
            x, y = y, x
        s >>= 1
    return acc + d


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        if pos >= len(buf) or shift > 63:
            raise PMTilesError("truncated or oversized varint in a directory")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


class Reader:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.size = self.path.stat().st_size
        with open(self.path, "rb") as f:
            raw = f.read(HEADER_LEN)
        self.header = self._header(raw)

    def _header(self, raw: bytes) -> Header:
        if len(raw) < HEADER_LEN or raw[:7] != b"PMTiles":
            raise PMTilesError("not a PMTiles archive (magic)")
        if raw[7] != 3:
            raise PMTilesError(f"PMTiles version {raw[7]}, expected 3")
        q = struct.unpack_from("<11Q", raw, 8)
        b = raw[96:102]
        e7 = struct.unpack_from("<4i", raw, 102)
        cz = raw[118]
        clon, clat = struct.unpack_from("<2i", raw, 119)
        h = Header(3, *q, bool(b[0]), COMPRESSIONS.get(b[1], f"code {b[1]}"), COMPRESSIONS.get(b[2], f"code {b[2]}"),
                   TILE_TYPES.get(b[3], f"code {b[3]}"), b[4], b[5], tuple(v / 1e7 for v in e7), (clon / 1e7, clat / 1e7, cz))
        for name, off, ln in (("root directory", h.root_offset, h.root_length), ("metadata", h.metadata_offset, h.metadata_length),
                              ("leaf directories", h.leaf_offset, h.leaf_length), ("tile data", h.data_offset, h.data_length)):
            if off + ln > self.size:
                raise PMTilesError(f"{name} reaches past the end of the file")
        if h.internal_compression not in ("none", "gzip"):
            raise PMTilesError(f"internal compression {h.internal_compression} is not readable by this tool")
        return h

    def _read(self, offset: int, length: int, limit: int) -> bytes:
        if length > limit:
            raise PMTilesError(f"section of {length} bytes is larger than the {limit}-byte limit")
        with open(self.path, "rb") as f:
            f.seek(offset)
            data = f.read(length)
        if len(data) != length:
            raise PMTilesError("truncated section")
        return data

    def _inflate(self, data: bytes, limit: int) -> bytes:
        if self.header.internal_compression == "none":
            return data
        try:
            with gzip.GzipFile(fileobj=__import__("io").BytesIO(data)) as g:
                out = g.read(limit + 1)
        except OSError as e:
            raise PMTilesError(f"corrupt compressed section: {e}") from None
        if len(out) > limit:
            raise PMTilesError("decompressed section exceeds its limit")
        return out

    def metadata(self) -> dict:
        h = self.header
        raw = self._inflate(self._read(h.metadata_offset, h.metadata_length, MAX_METADATA_BYTES), MAX_METADATA_BYTES)
        try:
            m = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise PMTilesError(f"metadata is not JSON: {e}") from None
        if not isinstance(m, dict):
            raise PMTilesError("metadata is not a JSON object")
        return m

    def _directory(self, offset: int, length: int) -> list[tuple[int, int, int, int]]:
        buf = self._inflate(self._read(offset, length, MAX_DIRECTORY_BYTES), MAX_DIRECTORY_BYTES)
        n, pos = _varint(buf, 0)
        if n > len(buf):
            raise PMTilesError("directory entry count larger than the directory")
        ids, runs, lens, offs = [], [], [], []
        last = 0
        for _ in range(n):
            v, pos = _varint(buf, pos)
            last += v
            ids.append(last)
        for _ in range(n):
            v, pos = _varint(buf, pos)
            runs.append(v)
        for _ in range(n):
            v, pos = _varint(buf, pos)
            lens.append(v)
        for i in range(n):
            v, pos = _varint(buf, pos)
            offs.append(offs[i - 1] + lens[i - 1] if v == 0 and i > 0 else v - 1)
        return list(zip(ids, runs, lens, offs))

    def entries(self):
        """Every tile entry (tile_id, run_length, length, offset), leaf directories followed, in tile-id order."""
        h = self.header
        stack = [(h.root_offset, h.root_length, 0)]
        while stack:
            off, ln, depth = stack.pop(0)
            if depth > 3:
                raise PMTilesError("directory nesting deeper than the format allows")
            for tid, run, length, o in self._directory(off, ln):
                if run == 0:
                    stack.append((h.leaf_offset + o, length, depth + 1))
                else:
                    if o + length > h.data_length:
                        raise PMTilesError(f"tile {tid} reaches past the tile data")
                    yield tid, run, length, o

    def tile_ids(self) -> set[int]:
        out: set[int] = set()
        for tid, run, _, _ in self.entries():
            out.update(range(tid, tid + run))
        return out

    def tile(self, z: int, x: int, y: int) -> bytes | None:
        target = zxy_to_tileid(z, x, y)
        h = self.header
        off, ln = h.root_offset, h.root_length
        for _ in range(4):
            entries = self._directory(off, ln)
            lo, hi, found = 0, len(entries) - 1, None
            while lo <= hi:
                mid = (lo + hi) // 2
                if entries[mid][0] <= target:
                    found, lo = entries[mid], mid + 1
                else:
                    hi = mid - 1
            if found is None:
                return None
            tid, run, length, o = found
            if run == 0:
                off, ln = h.leaf_offset + o, length
                continue
            if target >= tid + run:
                return None
            return self._read(h.data_offset + o, length, 16 * 1024 * 1024)
        raise PMTilesError("directory nesting deeper than the format allows")


def lon_to_x(lon: float, z: int) -> int:
    import math
    return min((1 << z) - 1, max(0, int((lon + 180.0) / 360.0 * (1 << z))))


def lat_to_y(lat: float, z: int) -> int:
    import math
    r = math.radians(lat)
    return min((1 << z) - 1, max(0, int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * (1 << z))))


def tile_centre(z: int, x: int, y: int) -> tuple[float, float]:
    import math
    n = 1 << z
    lon = (x + 0.5) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n))))
    return lon, lat


if __name__ == "__main__":
    import sys
    r = Reader(Path(sys.argv[1]))
    print(json.dumps({"header": r.header.__dict__, "metadata": r.metadata()}, ensure_ascii=False, indent=1, default=str)[:4000])
