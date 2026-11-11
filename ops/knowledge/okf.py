#!/usr/bin/env python3
"""TMRKZ's knowledge bundle in TNQL's OKF format (ADR-054): validate it, or write its manifest. Offline, standard library only.

  python ops/knowledge/okf.py validate            exit 1 on any problem
  python ops/knowledge/okf.py manifest            (re)writes manifest.json: every document's sha256, keeping its provenance

Each document under backend/src/main/resources/okf/ is Markdown with a front matter:
  okf_version "0.2" · type how-to|concept|reference|troubleshooting · resource tmrkz://okf/<path without .md> · title ·
  lifecycle current|draft|retired · verified YYYY-MM-DD · audience [all | SUPPORT_SEAT | permission names] · keywords [...] ·
  screen (an application view, optional)
The backend serves only documents whose bytes match the manifest, that are current and whose review state is verified-current.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / "backend/src/main/resources/okf"
PERMISSIONS = ROOT / "backend/src/main/java/ae/mover/access/Permission.java"
TYPES = {"how-to", "concept", "reference", "troubleshooting"}
LIFECYCLES = {"current", "draft", "retired"}
REVIEW_STATES = {"verified-current", "unverified-draft", "retired"}
REQUIRED = ["okf_version", "type", "resource", "title", "lifecycle", "verified", "audience", "keywords"]
SECRETS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|token|credential)\s*[:=]\s*\S{6,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\bbearer\s+[a-z0-9._-]{20,}"),
]


def permissions() -> set[str]:
    text = PERMISSIONS.read_text(encoding="utf-8")
    body = text[text.index("enum Permission"):]
    body = body[body.index("{") + 1:]
    body = body[: body.index(";")] if ";" in body else body
    body = body[: body.index("}")] if "}" in body else body
    body = re.sub(r"/\*.*?\*/|//[^\n]*", "", body, flags=re.S)
    return set(re.findall(r"\b[A-Z][A-Z0-9_]+\b", body))


def front_matter(text: str) -> tuple[dict[str, str], str] | None:
    t = text.replace("\r\n", "\n")
    if not t.startswith("---\n"):
        return None
    end = t.find("\n---\n", 4)
    if end < 0:
        return None
    fm: dict[str, str] = {}
    for line in t[4:end].split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            v = v.strip()
            if len(v) >= 2 and v.startswith('"') and v.endswith('"'):
                v = v[1:-1]
            fm[k.strip()] = v
    return fm, t[end + 5:]


def as_list(v: str) -> list[str]:
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    return [x.strip().strip('"') for x in v.split(",") if x.strip()]


def documents() -> list[Path]:
    return sorted(p for p in BUNDLE.rglob("*.md") if p.name not in {"index.md", "README.md"})


def validate() -> int:
    problems: list[str] = []
    allowed_audience = permissions() | {"all", "SUPPORT_SEAT"}
    manifest_path = BUNDLE / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    if manifest.get("okf_version") != "0.2":
        problems.append("manifest.json: okf_version must be 0.2")
    listed = {d.get("path"): d for d in manifest.get("documents", [])}
    resources: set[str] = set()
    for p in documents():
        rel = p.relative_to(BUNDLE).as_posix()
        raw = p.read_bytes()
        text = raw.decode("utf-8")
        parsed = front_matter(text)
        if parsed is None:
            problems.append(f"{rel}: no front matter")
            continue
        fm, body = parsed
        for k in REQUIRED:
            if not fm.get(k):
                problems.append(f"{rel}: '{k}' missing")
        if fm.get("okf_version") != "0.2":
            problems.append(f"{rel}: okf_version must be 0.2")
        if fm.get("type") not in TYPES:
            problems.append(f"{rel}: type '{fm.get('type')}'")
        if fm.get("lifecycle") not in LIFECYCLES:
            problems.append(f"{rel}: lifecycle '{fm.get('lifecycle')}'")
        want = "tmrkz://okf/" + rel[: -len(".md")]
        if fm.get("resource") != want:
            problems.append(f"{rel}: resource must be {want}")
        if fm.get("resource") in resources:
            problems.append(f"{rel}: resource used twice")
        resources.add(fm.get("resource", ""))
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fm.get("verified", "")):
            problems.append(f"{rel}: verified must be YYYY-MM-DD")
        for a in as_list(fm.get("audience", "")):
            if a not in allowed_audience:
                problems.append(f"{rel}: audience '{a}' is not all, SUPPORT_SEAT or a permission")
        if fm.get("screen") and not re.fullmatch(r"[A-Za-z]{1,40}", fm["screen"]):
            problems.append(f"{rel}: screen '{fm['screen']}'")
        if not body.strip():
            problems.append(f"{rel}: empty body")
        for rx in SECRETS:
            if rx.search(text):
                problems.append(f"{rel}: looks like a secret ({rx.pattern[:30]}…)")
        entry = listed.pop(rel, None)
        if entry is None:
            problems.append(f"{rel}: not in manifest.json")
            continue
        if entry.get("sha256") != hashlib.sha256(raw).hexdigest():
            problems.append(f"{rel}: sha256 differs from manifest.json (run: python ops/knowledge/okf.py manifest)")
        if entry.get("resource") != fm.get("resource"):
            problems.append(f"{rel}: manifest resource differs")
        if entry.get("provenance", {}).get("review_state") not in REVIEW_STATES:
            problems.append(f"{rel}: review_state")
    for rel in listed:
        problems.append(f"manifest.json lists {rel}, which does not exist")
    for p in problems:
        print("FAIL", p)
    n = len(documents())
    print(f"[okf] {n} documents, {len(problems)} problem(s)")
    return 1 if problems else 0


def write_manifest() -> int:
    path = BUNDLE / "manifest.json"
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    prov = {d["path"]: d.get("provenance", {}) for d in old.get("documents", [])}
    docs = []
    for p in documents():
        rel = p.relative_to(BUNDLE).as_posix()
        raw = p.read_bytes()
        parsed = front_matter(raw.decode("utf-8"))
        fm = parsed[0] if parsed else {}
        pv = prov.get(rel) or {"origin": "owner 2026-11-11", "review_state": "verified-current"}
        pv["freshness"] = fm.get("verified", pv.get("freshness", ""))
        docs.append({"path": rel, "resource": fm.get("resource", ""), "sha256": hashlib.sha256(raw).hexdigest(), "provenance": pv})
    out = {"okf_version": "0.2", "bundle": "tmrkz-okf", "description": "TMRKZ's own guide, in TNQL's OKF format (ADR-054)", "documents": docs}
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"[okf] manifest.json: {len(docs)} documents")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "validate"
    sys.exit(write_manifest() if cmd == "manifest" else validate())
