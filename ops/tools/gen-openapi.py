"""Generates docs/api/openapi.json (and the copy served at /api/v1/openapi.json) from the Spring controllers.

Paths, methods, path/query parameters, request bodies and Idempotency-Key headers are read from the mapping
annotations so the description cannot drift from the code. Response shapes are documented in docs/api/API_V1.md.
Usage: python ops/tools/gen-openapi.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "backend" / "src" / "main" / "java"
MAPPING = re.compile(r'@(Get|Post|Put|Patch|Delete)Mapping\((?:value\s*=\s*)?"([^"]+)"')
METHOD = re.compile(r'public\s+[\w<>\[\], .?]+\s+(\w+)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)', re.S)
ERRORS = {
    "400": "VALIDATION_FAILED / INVALID_WORKFLOW / SIGNATURE_REQUIRED",
    "401": "UNAUTHENTICATED",
    "403": "FORBIDDEN (also missing X-Requested-With on non-GET)",
    "404": "RESOURCE_NOT_FOUND (also used for objects outside the caller's scope)",
    "409": "STALE_REVISION / TASK_ALREADY_COMPLETED / RESERVATION_CONFLICT / IDEMPOTENCY_CONFLICT / ATTACHMENT_NOT_READY / WORKFLOW_NOT_PUBLISHED",
    "503": "SIGNATURE_PROVIDER_UNAVAILABLE",
}

paths = {}
for java in sorted(SRC.rglob("*Controller.java")):
    text = java.read_text(encoding="utf-8")
    base = re.search(r'@RequestMapping\("([^"]+)"\)', text)
    prefix = base.group(1) if base else ""
    tag = java.stem.replace("Controller", "")
    for m in MAPPING.finditer(text):
        verb, path = m.group(1).lower(), m.group(2)
        sig = METHOD.search(text, m.end())
        name, params = sig.group(1), sig.group(2)
        full = prefix + path
        op = {
            "tags": [tag],
            "operationId": name,
            "summary": re.sub(r"(?<!^)(?=[A-Z])", " ", name).lower(),
            "responses": {"200": {"description": "OK — see docs/api/API_V1.md for the JSON shape"}},
        }
        parameters = []
        for pv in re.findall(r"@PathVariable\s+\w+\s+(\w+)", params):
            parameters.append({"name": pv, "in": "path", "required": True, "schema": {"type": "string"}})
        for rp in re.finditer(r'@RequestParam\(([^)]*)\)\s+[\w<>]+\s+(\w+)', params):
            args, var = rp.group(1), rp.group(2)
            explicit = re.search(r'"(\w+)"', args)
            parameters.append({"name": explicit.group(1) if explicit else var, "in": "query",
                               "required": "required = false" not in args, "schema": {"type": "string"}})
        if "Idempotency-Key" in params:
            parameters.append({"name": "Idempotency-Key", "in": "header", "required": False,
                               "description": "Replays return the stored result; reuse with a different body → 409 IDEMPOTENCY_CONFLICT",
                               "schema": {"type": "string"}})
        if verb != "get":
            parameters.append({"name": "X-Requested-With", "in": "header", "required": True,
                               "schema": {"type": "string", "enum": ["mover"]}})
        if parameters:
            op["parameters"] = parameters
        if "@RequestBody" in params:
            op["requestBody"] = {"required": "required = false" not in params,
                                 "content": {"application/json": {"schema": {"type": "object"}}}}
        if "MultipartFile" in params:
            op["requestBody"] = {"required": True, "content": {"multipart/form-data": {"schema": {
                "type": "object", "properties": {"fieldId": {"type": "string"}, "file": {"type": "string", "format": "binary"}}}}}}
        op["responses"].update({k: {"description": v} for k, v in ERRORS.items()})
        paths.setdefault(full, {})[verb] = op

doc = {
    "openapi": "3.1.0",
    "info": {
        "title": "MOVER API",
        "version": "1.0.0",
        "description": "Administrative facilities, reservations and approvals. Session cookie MOVER_SESSION (HttpOnly, "
                       "SameSite=Strict). Times are ISO-8601 UTC; periods are half-open [start, end). "
                       "Generated from the controllers by ops/tools/gen-openapi.py; payload shapes in docs/api/API_V1.md.",
    },
    "servers": [{"url": "/"}],
    "components": {"securitySchemes": {"session": {"type": "apiKey", "in": "cookie", "name": "MOVER_SESSION"}}},
    "security": [{"session": []}],
    "paths": dict(sorted(paths.items())),
}
out = json.dumps(doc, ensure_ascii=False, indent=2)
(ROOT / "docs" / "api" / "openapi.json").write_text(out + "\n", encoding="utf-8")
(ROOT / "backend" / "src" / "main" / "resources" / "openapi.json").write_text(out + "\n", encoding="utf-8")
print(f"{sum(len(v) for v in paths.values())} operations across {len(paths)} paths")
