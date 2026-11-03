"""Extract named roads for the prototype's area from a local Protomaps PMTiles basemap (OSM-derived, ODbL).

Standard library only (PMTiles v3 directory + Mapbox Vector Tile decoding), read-only on the source file. Used to
demonstrate an OFFLINE road-name label pipeline in the isolated stationing prototype; the names are OpenStreetMap
names (non-authoritative). Official names (Abu Dhabi NRN, FGIC NSDI) wait for their licence to be confirmed.

Usage (from the repository root):
  python -I prototypes/stationing-ux/tools/extract_road_names.py <uae.pmtiles> prototypes/stationing-ux/src/v3/data/road-names.json
"""
import gzip
import hashlib
import json
import math
import struct
import sys

BBOX = (55.19, 25.07, 55.46, 25.33)  # lon0, lat0, lon1, lat1 — the prototype's illustrative basemap
ZOOM = 14
# carriageways only (no footways, cycleways, rail, ferries, piers)
ROAD_KINDS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def rotate(n, x, y, rx, ry):
    if ry == 0:
        if rx == 1:
            x, y = n - 1 - x, n - 1 - y
        return y, x
    return x, y


def zxy_to_tileid(z, x, y):
    acc = sum((1 << t) * (1 << t) for t in range(z))
    n = 1 << z
    d, s, tx, ty = 0, n // 2, x, y
    while s > 0:
        rx = 1 if tx & s else 0
        ry = 1 if ty & s else 0
        d += s * s * ((3 * rx) ^ ry)
        tx, ty = rotate(n, tx, ty, rx, ry)
        s //= 2
    return acc + d


def directory(raw):
    b = gzip.decompress(raw)
    n, i = varint(b, 0)
    ids, runs, lens, offs = [], [], [], []
    last = 0
    for _ in range(n):
        v, i = varint(b, i)
        last += v
        ids.append(last)
    for _ in range(n):
        v, i = varint(b, i)
        runs.append(v)
    for _ in range(n):
        v, i = varint(b, i)
        lens.append(v)
    for k in range(n):
        v, i = varint(b, i)
        offs.append(offs[k - 1] + lens[k - 1] if v == 0 and k > 0 else v - 1)
    return list(zip(ids, runs, lens, offs))


class PMTiles:
    def __init__(self, path):
        self.f = open(path, 'rb')
        h = self.f.read(127)
        assert h[:7] == b'PMTiles' and h[7] == 3, 'not a PMTiles v3 file'
        (self.root_off, self.root_len, _, _, self.leaf_off, _, self.data_off, _, _, _, _) = struct.unpack('<11Q', h[8:96])
        assert h[97] == 2, 'internal compression must be gzip'
        self.tile_gzip = h[98] == 2

    def read(self, off, length):
        self.f.seek(off)
        return self.f.read(length)

    def tile(self, z, x, y):
        tid = zxy_to_tileid(z, x, y)
        entries = directory(self.read(self.root_off, self.root_len))
        for _ in range(4):
            hit = None
            for e in entries:
                if e[0] <= tid and (e[1] == 0 or tid < e[0] + e[1]):
                    hit = e
                elif e[0] > tid:
                    break
            if hit is None:
                return None
            if hit[1] == 0:
                entries = directory(self.read(self.leaf_off + hit[3], hit[2]))
                continue
            data = self.read(self.data_off + hit[3], hit[2])
            return gzip.decompress(data) if self.tile_gzip else data
        return None


def fields(b):
    i = 0
    while i < len(b):
        key, i = varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0:
            v, i = varint(b, i)
        elif t == 2:
            ln, i = varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif t == 1:
            v = b[i:i + 8]
            i += 8
        elif t == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError('wire type %d' % t)
        yield f, t, v


def packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = varint(b, i)
        out.append(v)
    return out


def value(b):
    for f, t, v in fields(b):
        if f == 1:
            return v.decode('utf-8')
        if f in (4, 5):
            return v
        if f == 6:
            return (v >> 1) ^ -(v & 1)
        if f == 7:
            return bool(v)
        if f == 3:
            return struct.unpack('<d', v)[0]
        if f == 2:
            return struct.unpack('<f', v)[0]
    return None


def lines(geom):
    out, cur, x, y, i = [], None, 0, 0, 0
    while i < len(geom):
        cmd, count = geom[i] & 7, geom[i] >> 3
        i += 1
        if cmd == 7:
            continue
        for _ in range(count):
            dx, dy = geom[i], geom[i + 1]
            i += 2
            x += (dx >> 1) ^ -(dx & 1)
            y += (dy >> 1) ^ -(dy & 1)
            if cmd == 1:
                cur = [(x, y)]
                out.append(cur)
            else:
                cur.append((x, y))
    return out


def roads(tile, z, tx, ty):
    for f, _, layer in fields(tile):
        if f != 3:
            continue
        name, keys, vals, feats, extent = None, [], [], [], 4096
        for g, _, v in fields(layer):
            if g == 1:
                name = v.decode()
            elif g == 2:
                feats.append(v)
            elif g == 3:
                keys.append(v.decode())
            elif g == 4:
                vals.append(value(v))
            elif g == 5:
                extent = v
        if name != 'roads':
            continue
        for ft in feats:
            tags, geom, gtype = [], [], 0
            for g, _, v in fields(ft):
                if g == 2:
                    tags = packed(v)
                elif g == 3:
                    gtype = v
                elif g == 4:
                    geom = packed(v)
            if gtype != 2:
                continue
            props = {keys[tags[k]]: vals[tags[k + 1]] for k in range(0, len(tags), 2)}
            if not (props.get('name:ar') or props.get('name:en') or props.get('name')):
                continue
            n = 2 ** z
            for ln in lines(geom):
                pts = []
                for px, py in ln:
                    lon = (tx + px / extent) / n * 360 - 180
                    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + py / extent) / n))))
                    pts.append([round(lat, 5), round(lon, 5)])
                if len(pts) >= 2:
                    yield props, pts


def main(src, out):
    pm = PMTiles(src)
    lon0, lat0, lon1, lat1 = BBOX
    n = 2 ** ZOOM
    x0 = int((lon0 + 180) / 360 * n)
    x1 = int((lon1 + 180) / 360 * n)
    yt = lambda lat: int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    y0, y1 = yt(lat1), yt(lat0)
    feats, kinds = [], {}
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            t = pm.tile(ZOOM, x, y)
            if not t:
                continue
            for p, pts in roads(t, ZOOM, x, y):
                k = p.get('kind_detail') or p.get('kind') or ''
                if k not in ROAD_KINDS:
                    continue
                kinds[k] = kinds.get(k, 0) + 1
                feats.append({'k': p.get('kind', ''), 'd': p.get('kind_detail', ''), 'ar': p.get('name:ar') or '', 'en': p.get('name:en') or p.get('name') or '', 'g': pts})
    with open(src, 'rb') as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    doc = {
        'source': 'Protomaps Basemap (OpenStreetMap) — local PMTiles, roads layer, zoom %d' % ZOOM,
        'sourceSha256': sha,
        'licence': 'ODbL 1.0 — © OpenStreetMap contributors; Protomaps',
        'authority': 'NON-AUTHORITATIVE (OpenStreetMap names). Official names: Abu Dhabi NRN / FGIC NSDI, licence to be confirmed.',
        'bbox': BBOX,
        'kinds': kinds,
        'features': feats,
    }
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print('features', len(feats), 'kinds', kinds)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
