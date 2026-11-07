"""Read-only measurement: coverage of the terrain data, and how the display colours (35 m Terrain-RGB, as the browser
computes them) compare with the native 30 m slope analysis the server uses, on real mountain ground. Run from the repo root."""
import glob
import io
import json
import math
import os

import numpy as np
import rasterio
from PIL import Image
from pmtiles.reader import MmapSource, Reader
from rasterio.windows import from_bounds

A = 'map-data/terrain/glo30/analysis'
m = json.load(open('map-packages/terrain-glo30-2026.11/manifest.json'))
files = sorted(os.path.basename(p) for p in glob.glob(A + '/slope_pct_x100_*.tif'))
codes = [f[len('slope_pct_x100_'):-4] for f in files]
grid = [f'N{a}E{b:03d}' for a in range(22, 27) for b in range(51, 57)]
print('grid cells', len(grid), '| slope files', len(files), '| absent', [g for g in grid if g not in codes], '| recorded absent', m['coverage']['absent'])

BANDS = [(0, 10, 'green'), (10, 30, 'orange'), (30, 1e9, 'red')]


def read_native(w, s, e, n):
    out = []
    for f in files:
        with rasterio.open(os.path.join(A, f)) as d:
            b = d.bounds
            if b.right <= w or b.left >= e or b.top <= s or b.bottom >= n:
                continue
            win = from_bounds(max(w, b.left), max(s, b.bottom), min(e, b.right), min(n, b.top), d.transform).round_offsets().round_lengths()
            a = d.read(1, window=win)
            t = d.window_transform(win)
            out.append((a, t))
    return out


print('\n--- known mountain and desert places: does the analysis hold real slopes there? (public places, 2 km box)')
for name, lat, lng in [('Jebel Jais, Ras Al Khaimah', 25.95, 56.15), ('Jebel Hafeet, Al Ain', 24.06, 55.78), ('Hatta', 24.80, 56.12), ('Fujairah mountains', 25.25, 56.25), ('Liwa dunes', 23.10, 53.80), ('Abu Dhabi coast plain', 24.40, 54.60)]:
    d = 0.01
    vals = np.concatenate([a[a != 65535].ravel() for a, _ in read_native(lng - d, lat - d, lng + d, lat + d)] or [np.array([])]) / 100
    print(f'{name:30s} cells {vals.size:6d}  mean {vals.mean() if vals.size else float("nan"):6.1f}%  p95 {np.percentile(vals, 95) if vals.size else float("nan"):6.1f}%  max {vals.max() if vals.size else float("nan"):6.1f}%')

# ---- display slope, the browser's method: Terrain-RGB z12, Horn on each tile's own pixels ------------------------------
Z, SIZE = 12, 256
N = 2 ** Z
src = open('map-data/terrain/glo30/visualization-3d/terrain-rgb.pmtiles', 'rb')
reader = Reader(MmapSource(src))
cache = {}


def display_tile(x, y):
    if (x, y) in cache:
        return cache[(x, y)]
    raw = reader.get(Z, x, y)
    if not raw:
        cache[(x, y)] = None
        return None
    rgb = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), dtype=np.float64)
    h = -10000 + (rgb[..., 0] * 65536 + rgb[..., 1] * 256 + rgb[..., 2]) * 0.1
    p = np.pad(h, 1, mode='edge')
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:] - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2]))
    gy = (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:] - (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]))
    rows = (y + (np.arange(SIZE) + 0.5) / SIZE)
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * rows / N))))
    cell = 40075016.686 * np.cos(np.radians(lat)) / (SIZE * N)
    dx = np.full((SIZE, SIZE), 8.0)
    dy = np.full((SIZE, SIZE), 8.0)
    dx[:, [0, -1]] = 4
    dy[[0, -1], :] = 4
    pct = np.hypot(gx / (dx * cell[:, None]), gy / (dy * cell[:, None])) * 100
    cache[(x, y)] = pct
    return pct


def display_at(lon, lat):
    fx = (lon + 180) / 360 * N * SIZE
    s = np.sin(np.radians(lat))
    fy = (0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)) * N * SIZE
    i = np.floor(fx).astype(int)
    j = np.floor(fy).astype(int)
    out = np.full(lon.shape, np.nan)
    ti, tj = i // SIZE, j // SIZE
    for tx in np.unique(ti):
        for ty in np.unique(tj):
            t = display_tile(int(tx), int(ty))
            mask = (ti == tx) & (tj == ty)
            if t is not None and mask.any():
                out[mask] = t[j[mask] % SIZE, i[mask] % SIZE]
    return out


def tone(v):
    return np.select([v < 10, v < 30], [0, 1], 2)


names = ['green', 'orange', 'red']
print('\n--- each native 30 m cell against the colour shown for the same ground')
for name, w, s, e, n in [('Hajar, Hatta to Al Dhaid', 55.95, 24.60, 56.35, 25.30), ('Ras Al Khaimah mountains', 56.00, 25.70, 56.25, 26.05), ('Jebel Hafeet', 55.72, 23.98, 55.84, 24.15)]:
    nat, dis = [], []
    for a, t in read_native(w, s, e, n):
        rows, cols = np.mgrid[0:a.shape[0]:2, 0:a.shape[1]:2]
        lon = t.c + (cols + 0.5) * t.a
        lat = t.f + (rows + 0.5) * t.e
        v = a[rows, cols]
        keep = v != 65535
        nat.append(v[keep] / 100)
        dis.append(display_at(lon[keep], lat[keep]))
    nat = np.concatenate(nat)
    dis = np.concatenate(dis)
    ok = ~np.isnan(dis)
    nat, dis = nat[ok], dis[ok]
    a, b = tone(nat), tone(dis)
    print(f'\n{name}: {nat.size:,} cells; native mean {nat.mean():.1f}%, display mean {dis.mean():.1f}%, cells where the display reads lower {100 * (dis < nat).mean():.0f}%')
    print('  native \\ shown   ' + ''.join(f'{x:>9s}' for x in names))
    for i in range(3):
        row = a == i
        print(f'  {names[i]:16s}' + ''.join(f'{100 * (b[row] == j).mean() if row.any() else 0:8.1f}%' for j in range(3)) + f'   ({100 * row.mean():.1f}% of ground)')
    print(f'  steep native cells (>=30%) shown GREEN: {100 * (b[a == 2] == 0).mean():.2f}%  |  of all cells shown green, truly >=10%: {100 * (a[b == 0] > 0).mean():.1f}%, truly >=30%: {100 * (a[b == 0] == 2).mean():.2f}%')

# ---- whole sites: a 600 m square whose colour is decided by the most ground, native against display --------------------
print('\n--- whole sites of about 600 x 600 m on mountain ground (the sentence at the top of the legend)')
w, s, e, n = 55.95, 24.60, 56.35, 25.30
rng = np.random.default_rng(7)
wrong = {}
missed_red = []
count = 0
tiles = read_native(w, s, e, n)
for _ in range(1500):
    lon0, lat0 = rng.uniform(w, e), rng.uniform(s, n)
    d = 300 / 110900
    nvals = []
    for a, t in tiles:
        c0 = int((lon0 - d - t.c) / t.a)
        c1 = int((lon0 + d - t.c) / t.a)
        r0 = int((lat0 + d - t.f) / t.e)
        r1 = int((lat0 - d - t.f) / t.e)
        if c0 < 0 or r0 < 0 or c1 >= a.shape[1] or r1 >= a.shape[0]:
            continue
        nvals.append(a[r0:r1, c0:c1].ravel())
    if not nvals:
        continue
    nv = np.concatenate(nvals)
    nv = nv[nv != 65535] / 100
    if nv.size < 100:
        continue
    gx, gy = np.meshgrid(np.linspace(lon0 - d, lon0 + d, 17), np.linspace(lat0 - d, lat0 + d, 17))
    dv = display_at(gx.ravel(), gy.ravel())
    dv = dv[~np.isnan(dv)]
    if not dv.size:
        continue
    nt = np.bincount(tone(nv), minlength=3).argmax()
    dt = np.bincount(tone(dv), minlength=3).argmax()
    wrong[(names[nt], names[dt])] = wrong.get((names[nt], names[dt]), 0) + 1
    if dt == 0:
        missed_red.append((100 * (nv >= 30).mean(), nv.max()))
    count += 1
print(f'{count} sites; native verdict -> shown verdict:')
for k in sorted(wrong):
    print(f'  {k[0]:7s} -> {k[1]:7s} {wrong[k]:5d}')
if missed_red:
    mr = np.array(missed_red)
    print(f'sites shown green: {len(mr)}; with some native red ground in them: {100 * (mr[:, 0] > 0).mean():.0f}%; with over 10% native red: {100 * (mr[:, 0] > 10).mean():.1f}%; steepest native cell in a green site: {mr[:, 1].max():.0f}%')
