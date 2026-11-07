#!/usr/bin/env python3
"""Installs a TMRKZ offline map package into a map root, restores the previous one, or reports what is installed.

A map root holds only:
  current/   the active package; the web entry point serves exactly this directory under /map-data/
  previous/  the package the last install replaced, kept whole so it can be restored without any download
  history/   install-log.jsonl and a copy of every installed or replaced package's manifest
and, while an operation runs, .lock and .staging-*/.discard-*/.swap-* directories.

  python ops/map-package/install_package.py install --package <dir|tar> --root <map-root> [--expect-sha256 <tar sha256>]
  python ops/map-package/install_package.py install ... --confirm <map-root>          # the same, carried out
  python ops/map-package/install_package.py restore-previous --root <map-root> [--confirm <map-root>]
  python ops/map-package/install_package.py status --root <map-root> [--full]

Without --confirm (set to the same root) nothing is written: the plan is printed and the exit code is 3. Install
verifies the package in full first (layout, every checksum, every component's content; package_format.py), refuses a
corrupted, incomplete or unexpected package, copies only the listed files into a staging directory on the same disk,
verifies the copy again, and then swaps directories by rename: current → previous, staging → current. If anything
fails before the swap the active package is untouched; if the last rename fails the earlier one is undone. The web
server never sees a partly copied package. Exit codes: 0 done (or already installed), 1 refused or failed, 2 usage,
3 plan only.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
import package_format as pf  # noqa: E402

SLOTS = ("current", "previous", "history")
TRANSIENT = (".lock", ".staging-", ".discard-", ".swap-")


class Refused(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def say(msg: str) -> None:
    print(f"[map-install] {msg}", flush=True)


def check_root(root: Path, package: Path | None) -> Path:
    """The root must be a dedicated map root: absolute, not a system/home/repository directory, not a link, holding
    nothing but the slots above, and neither inside the package nor containing the package in a slot."""
    if not root.is_absolute():
        raise Refused(f"the map root must be an absolute path, got {root}")
    r = Path(os.path.abspath(root))
    forbidden = {Path(r.anchor), Path.home(), REPO, REPO.parent}
    if r in forbidden or r == Path(os.path.abspath(Path.home().parent)):
        raise Refused(f"refusing {r}: a filesystem root, home or repository directory is never a map root")
    if REPO.is_relative_to(r) if hasattr(REPO, "is_relative_to") else str(REPO).startswith(str(r) + os.sep):
        raise Refused(f"refusing {r}: it contains the repository")
    if r.exists():
        if pf._is_link(r) or not r.is_dir():
            raise Refused(f"refusing {r}: not a plain directory (link, junction or file)")
        odd = [e.name for e in r.iterdir() if e.name not in SLOTS and not e.name.startswith(TRANSIENT)]
        if odd:
            raise Refused(f"refusing {r}: it holds {odd[:5]}, which a map root never does (choose an empty directory)")
        for s in SLOTS:
            if (r / s).exists() and pf._is_link(r / s):
                raise Refused(f"refusing {r / s}: a link or junction")
    if package is not None:
        p = Path(os.path.abspath(package))
        if p == r or str(p).startswith(str(r) + os.sep) or str(r).startswith(str(p) + os.sep):
            raise Refused(f"refusing: the package {p} and the map root {r} overlap; install from a separate copy")
    return r


class Lock:
    def __init__(self, root: Path):
        self.path = root / ".lock"

    def __enter__(self):
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise Refused(f"{self.path} exists: another operation is running, or one was interrupted (check, then "
                          "remove the file)") from None
        os.write(fd, f"{os.getpid()} {now()}\n".encode())
        os.close(fd)
        return self

    def __exit__(self, *exc):
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def slot_manifest(slot: Path) -> dict | None:
    m = slot / "manifest.json"
    if not m.is_file():
        return None
    try:
        return json.loads(m.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def log(root: Path, entry: dict) -> None:
    h = root / "history"
    h.mkdir(exist_ok=True)
    with open(h / "install-log.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def keep_manifest(root: Path, slot: Path, tag: str) -> str | None:
    m = slot_manifest(slot)
    if not m:
        return None
    h = root / "history"
    h.mkdir(exist_ok=True)
    name = f"{now().replace(':', '')}-{m.get('packageId', 'unknown')}-{tag}.manifest.json"
    shutil.copyfile(slot / "manifest.json", h / name)
    return f"history/{name}"


def copy_listed(src: Path, manifest: dict, dst: Path) -> None:
    """Copies exactly the files the manifest lists (plus manifest.json and SHA256SUMS), from a directory or a tar."""
    names = list(pf.ROOT_FILES) + [f["path"] for f in manifest["files"]]
    for n in names:
        if pf.path_problem(n):
            raise Refused(f"unsafe path {n!r}")
    if src.is_file():
        import tarfile
        with tarfile.open(src, "r:") as tf:
            members = {}
            for ti in tf.getmembers():
                top, _, rel = ti.name.partition("/")
                if top == manifest["packageId"] and ti.isreg():
                    members[rel] = ti
            for n in names:
                out = dst / n
                out.parent.mkdir(parents=True, exist_ok=True)
                with tf.extractfile(members[n]) as fi, open(out, "xb") as fo:
                    shutil.copyfileobj(fi, fo, 4 * 1024 * 1024)
    else:
        for n in names:
            out = dst / n
            out.parent.mkdir(parents=True, exist_ok=True)
            with open(src / n, "rb") as fi, open(out, "xb") as fo:
                shutil.copyfileobj(fi, fo, 4 * 1024 * 1024)


def install(package: Path, root: Path, confirm: str | None, expect_sha: str | None, deep: bool = True) -> int:
    package = Path(os.path.abspath(package))
    root = check_root(root, package)
    say(f"package {package}")
    if package.is_file() and expect_sha:
        got = pf.sha256_file(package)
        if got != expect_sha:
            raise Refused(f"archive sha256 {got} is not the expected {expect_sha}")
        say(f"archive sha256 matches the expected {expect_sha}")
    started = time.time()
    r = pf.verify(package, full=True, deep=deep)  # an archive's PMTiles are read again from the staged copy
    pf.print_result(r)
    if not r.ok:
        raise Refused("the package failed verification; nothing was installed")
    m = r.manifest
    cur, prev = root / "current", root / "previous"
    cm, pm = slot_manifest(cur), slot_manifest(prev)
    free = shutil.disk_usage(root if root.exists() else root.parent).free
    need = m["totals"]["bytes"]
    say("plan")
    print(f"  map root        : {root}")
    print(f"  package         : {m['packageId']} ({m['totals']['files']} files, {need} bytes, contentSha256 {m['contentSha256']})")
    print(f"  active now      : {cm.get('packageId', '?') + ' (' + cm.get('contentSha256', 'not a package') + ')' if cm else 'none'}")
    print(f"  kept now        : {pm['packageId'] if pm else 'none'}")
    if cm and cm.get("contentSha256") == m["contentSha256"]:
        q = pf.verify(cur, full=True, deep=False)
        if q.ok:
            say(f"{m['packageId']} is already the active package and verifies in full; nothing to do")
            return 0
        say("the active package has the same id but no longer verifies; it will be replaced")
    print(f"  will copy to    : {root / ('.staging-' + m['packageId'])} (then verify it again)")
    print(f"  then            : " + (f"current → previous{' (replacing the kept ' + pm['packageId'] + ')' if pm else ''}; " if cm else "")
          + "staging → current")
    print(f"  disk            : {free} bytes free, {need} needed")
    if free < need * 1.05:
        raise Refused("not enough free disk space for the staging copy")
    if confirm is None or Path(os.path.abspath(confirm)) != root:
        say(f"plan only: run again with --confirm {root} to install")
        return 3
    root.mkdir(parents=True, exist_ok=True)
    with Lock(root):
        stage = root / f".staging-{m['packageId']}-{os.getpid()}"
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir()
        try:
            say(f"copying {m['totals']['files']} files to {stage}")
            copy_listed(package, m, stage)
            v = pf.verify(stage, full=True, deep=deep)
            pf.print_result(v)
            if not v.ok:
                raise Refused("the staged copy does not verify; the active package is unchanged")
            replaced = keep_manifest(root, cur, "replaced") if cur.exists() else None
            discard = root / f".discard-{os.getpid()}"
            if prev.exists():
                os.replace(prev, discard)
            moved = False
            try:
                if cur.exists():
                    os.replace(cur, prev)
                    moved = True
                os.replace(stage, cur)
            except OSError as e:
                if moved and not cur.exists():
                    os.replace(prev, cur)
                if discard.exists() and not prev.exists():
                    os.replace(discard, prev)
                raise Refused(f"swap failed ({e}); the active package was restored unchanged. A file of it may be in use "
                              "(stop the web container briefly on Windows hosts, then run the install again)") from None
            shutil.rmtree(discard, ignore_errors=True)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        kept = keep_manifest(root, cur, "installed")
        after = pf.verify(cur, full=False, deep=False)
        if not after.ok or slot_manifest(cur)["contentSha256"] != m["contentSha256"]:
            raise Refused("the installed package does not match after the swap; restore with restore-previous")
        log(root, {"at": now(), "action": "install", "packageId": m["packageId"], "contentSha256": m["contentSha256"],
                   "manifestSha256": pf.sha256_file(cur / "manifest.json"), "previous": cm.get("packageId") if cm else None,
                   "previousContentSha256": cm.get("contentSha256") if cm else None, "from": str(package),
                   "archiveSha256": expect_sha, "manifestCopy": kept, "replacedManifestCopy": replaced,
                   "seconds": round(time.time() - started, 1)})
    say(f"installed {m['packageId']} at {cur}" + (f"; {cm.get('packageId')} kept at {prev}" if cm else "")
        + f" ({time.time() - started:.0f} s)")
    return 0


def restore_previous(root: Path, confirm: str | None, deep: bool = True) -> int:
    root = check_root(root, None)
    cur, prev = root / "current", root / "previous"
    if not prev.is_dir():
        raise Refused(f"no previous package at {prev}")
    r = pf.verify(prev, full=True, deep=deep)
    pf.print_result(r)
    if not r.ok:
        raise Refused("the previous package does not verify; it cannot be restored")
    cm, pm = slot_manifest(cur), r.manifest
    say("plan")
    print(f"  map root   : {root}")
    print(f"  restore    : {pm['packageId']} ({pm['contentSha256']}) → current")
    print(f"  active now : {cm['packageId'] if cm else 'none'} → previous (so the change can be undone the same way)")
    if confirm is None or Path(os.path.abspath(confirm)) != root:
        say(f"plan only: run again with --confirm {root} to restore")
        return 3
    with Lock(root):
        swap = root / f".swap-{os.getpid()}"
        if cur.exists():
            os.replace(cur, swap)
        try:
            os.replace(prev, cur)
        except OSError as e:
            if swap.exists():
                os.replace(swap, cur)
            raise Refused(f"restore failed ({e}); nothing changed") from None
        if swap.exists():
            os.replace(swap, prev)
        log(root, {"at": now(), "action": "restore-previous", "packageId": pm["packageId"],
                   "contentSha256": pm["contentSha256"], "previous": cm["packageId"] if cm else None,
                   "previousContentSha256": cm["contentSha256"] if cm else None})
    say(f"restored {pm['packageId']} as current" + (f"; {cm['packageId']} is now previous" if cm else ""))
    return 0


def status(root: Path, full: bool) -> int:
    root = check_root(root, None)
    rc = 0
    for slot in ("current", "previous"):
        p = root / slot
        if not p.exists():
            print(f"  {slot:8}: none")
            rc = rc or (1 if slot == "current" else 0)
            continue
        r = pf.verify(p, full=full, deep=full)
        m = r.manifest or {}
        print(f"  {slot:8}: {m.get('packageId', '?')} contentSha256 {m.get('contentSha256', '?')} — "
              f"{'VALID' if r.ok else 'INVALID: ' + '; '.join(r.problems)[:300]} ({'full' if full else 'sizes only'})")
        if slot == "current" and not r.ok:
            rc = 1
    logf = root / "history" / "install-log.jsonl"
    if logf.exists():
        for line in logf.read_text(encoding="utf-8").splitlines()[-5:]:
            e = json.loads(line)
            print(f"  log     : {e['at']} {e['action']} {e['packageId']} (previous {e.get('previous')})")
    return rc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("install")
    i.add_argument("--package", required=True)
    i.add_argument("--root", required=True)
    i.add_argument("--confirm")
    i.add_argument("--expect-sha256")
    rp = sub.add_parser("restore-previous")
    rp.add_argument("--root", required=True)
    rp.add_argument("--confirm")
    st = sub.add_parser("status")
    st.add_argument("--root", required=True)
    st.add_argument("--full", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "install":
            return install(Path(a.package), Path(a.root), a.confirm, a.expect_sha256)
        if a.cmd == "restore-previous":
            return restore_previous(Path(a.root), a.confirm)
        say(f"status of {a.root}")
        return status(Path(a.root), a.full)
    except Refused as e:
        say(f"REFUSED: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
