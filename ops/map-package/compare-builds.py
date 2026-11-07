#!/usr/bin/env python3
"""Compares two independent builds, file by file: the same paths, sizes and sha256, or it exits 1.
  python3 ops/map-package/compare-builds.py <dir-a> <dir-b> [relative-subdir ...]
"""
import hashlib
import sys
from pathlib import Path


def tree(root: Path) -> dict:
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() and ".git" not in p.parts and "node_modules" not in p.parts and "__pycache__" not in p.parts:
            h = hashlib.sha256()
            with p.open("rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            out[str(p.relative_to(root))] = (p.stat().st_size, h.hexdigest())
    return out


a, b, *subs = sys.argv[1:]
bad = 0
total = 0
for sub in subs or ["."]:
    ta, tb = tree(Path(a) / sub), tree(Path(b) / sub)
    for k in sorted(set(ta) | set(tb)):
        total += 1
        if ta.get(k) != tb.get(k):
            bad += 1
            print(f"DIFF {sub}/{k}: {ta.get(k)} vs {tb.get(k)}")
print(f"{total} files compared, {bad} differ")
sys.exit(1 if bad else 0)
