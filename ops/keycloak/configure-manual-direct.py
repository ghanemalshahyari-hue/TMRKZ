#!/usr/bin/env python3
"""Configure manual direct LDAP without copying or storing any user's password.

Reads the protected local staging record produced during enterprise-directory preparation, imports only public CA
certificates into the local truststore used by both TMRKZ and its stand-in Keycloak provider, updates the dedicated
TMRKZ_MANUAL_* overrides, and generates a fixed raw-TLS relay bound to the internal bridge gateway.

Use: python3 ops/keycloak/configure-manual-direct.py --stage-file <protected.json> --bind-pattern-file <protected.txt>
The bind-pattern file contains exactly one {username} marker, for example the value from a working direct-bind app.
"""
from __future__ import annotations

import argparse
import errno
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
BEGIN = "# BEGIN TMRKZ manual enterprise LDAP (generated local configuration; no passwords)"
END = "# END TMRKZ manual enterprise LDAP"
KEYS = {
    "LDAP_URL": "TMRKZ_MANUAL_LDAP_URL",
    "LDAP_START_TLS": "TMRKZ_MANUAL_LDAP_START_TLS",
    "LDAP_USERS_DN": "TMRKZ_MANUAL_LDAP_USERS_DN",
    "LDAP_USERNAME_ATTRIBUTE": "TMRKZ_MANUAL_LDAP_USERNAME_ATTRIBUTE",
    "LDAP_UUID_ATTRIBUTE": "TMRKZ_MANUAL_LDAP_UUID_ATTRIBUTE",
    "LDAP_EMPLOYEE_NUMBER_ATTRIBUTE": "TMRKZ_MANUAL_LDAP_EMPLOYEE_NUMBER_ATTRIBUTE",
    "LDAP_USER_OBJECT_CLASS": "TMRKZ_MANUAL_LDAP_USER_OBJECT_CLASS",
}


def clean(value: object, name: str) -> str:
    text = str(value or "").strip()
    if not text or any(c in text for c in "\r\n\x00") or "'" in text:
        raise ValueError(f"invalid or missing staged value: {name}")
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-file", required=True, type=Path)
    parser.add_argument("--bind-pattern-file", required=True, type=Path)
    parser.add_argument("--compose-project", default="tmrkz-mover")
    args = parser.parse_args()

    stage = json.loads(args.stage_file.read_text(encoding="utf-8"))
    config = stage["configuration"]
    values = {target: clean(config[source], source) for source, target in KEYS.items()}
    values["TMRKZ_MANUAL_LDAP_DIRECT_BIND_PATTERN"] = clean(
        args.bind_pattern_file.read_text(encoding="utf-8"), "direct bind pattern"
    )
    pattern = values["TMRKZ_MANUAL_LDAP_DIRECT_BIND_PATTERN"]
    if pattern.count("{username}") != 1:
        raise ValueError("the direct bind pattern must contain exactly one {username} marker")

    parsed = urllib.parse.urlsplit(values["TMRKZ_MANUAL_LDAP_URL"])
    if parsed.scheme not in {"ldaps", "ldap"} or parsed.username or parsed.password:
        raise ValueError("the staged LDAP_URL must be a credential-free ldaps:// or ldap:// URL")
    if parsed.scheme == "ldap" and values["TMRKZ_MANUAL_LDAP_START_TLS"].lower() != "true":
        raise ValueError("plain ldap:// requires StartTLS")
    # The same lowercase spelling must be used by JNDI and the Compose host alias (which can be case-sensitive
    # in practice). This changes only name resolution, not the endpoint, trust anchor or TLS hostname check.
    hostname = clean(parsed.hostname, "directory DNS name").lower()
    host_port = hostname if parsed.port is None else f"{hostname}:{parsed.port}"
    values["TMRKZ_MANUAL_LDAP_URL"] = urllib.parse.urlunsplit(
        (parsed.scheme, host_port, parsed.path, parsed.query, parsed.fragment)
    )
    if not re.fullmatch(r"[A-Za-z0-9.-]+", hostname):
        raise ValueError("the relay requires an approved DNS hostname, not an arbitrary expression")
    port = parsed.port or (636 if parsed.scheme == "ldaps" else 389)
    if not 1 <= port <= 65535:
        raise ValueError("invalid directory port")

    gateway = subprocess.check_output(
        ["docker", "network", "inspect", f"{args.compose_project}_internal", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
        text=True,
    ).strip()
    ipaddress.ip_address(gateway)
    generated = ROOT / "ops/local/.generated/manual-directory"
    generated.mkdir(parents=True, exist_ok=True)
    relay = generated / "nginx.conf"
    relay.write_text(
        "worker_processes 1;\npid /tmp/nginx-manual-ldap.pid;\nerror_log /dev/stderr warn;\n"
        "events { worker_connections 64; }\nstream {\n"
        f"  server {{\n    listen {gateway}:{port};\n    proxy_connect_timeout 5s;\n"
        f"    proxy_timeout 20s;\n    proxy_pass {hostname}:{port};\n  }}\n}}\n",
        encoding="utf-8",
    )
    os.chmod(relay, 0o600)
    values.update({
        "TMRKZ_MANUAL_LDAP_DNS_NAME": hostname,
        "TMRKZ_MANUAL_LDAP_RELAY_GATEWAY": gateway,
        "TMRKZ_MANUAL_LDAP_RELAY_CONFIG": str(relay),
    })

    # Keep the local stand-in trust for automatic platform sign-in, adding only public enterprise CA material.
    source_ca = Path(clean(config.get("TMRKZ_TRUSTSTORE_DIR"), "TMRKZ_TRUSTSTORE_DIR"))
    target_ca = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "tmrkz-mover/local-truststore"
    target_ca.mkdir(parents=True, exist_ok=True)
    imported = 0
    for source in sorted(source_ca.iterdir()):
        if not source.is_file() or source.suffix.lower() not in {".pem", ".crt", ".cer"}:
            continue
        content = source.read_bytes()
        if b"PRIVATE KEY" in content or b"BEGIN CERTIFICATE" not in content:
            raise ValueError(f"refusing non-public or unreadable CA file: {source.name}")
        target = target_ca / f"enterprise-{source.name}"
        target.write_bytes(content)
        os.chmod(target, 0o644)
        imported += 1
    if imported == 0:
        raise ValueError("no public CA certificates found in the staged truststore")

    env = ROOT / ".env"
    lines = env.read_text(encoding="utf-8").splitlines() if env.exists() else []
    block = [BEGIN]
    block.extend(f"{key}='{values[key]}'" for key in sorted(values))
    block.append(END)
    try:
        start = lines.index(BEGIN)
        end = lines.index(END)
        lines = lines[:start] + block + lines[end + 1:]
    except ValueError:
        if lines and lines[-1]:
            lines.append("")
        lines.extend(block)
    temporary = env.with_suffix(".env.manual-direct.tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    try:
        os.replace(temporary, env)
    except OSError as error:
        # A vboxsf/Windows-shared .env can be open by another tool and reject rename with ETXTBSY/EPERM.
        if error.errno not in {errno.ETXTBSY, errno.EPERM}:
            raise
        shutil.copyfile(temporary, env)
        temporary.unlink()
    print(f"PASS: manual direct LDAP configured from staged metadata; {imported} public CA files trusted; no user password stored.")
    print("The fixed relay is bound to the internal gateway only. Set COMPOSE_PROFILES=enterprise-ldap in .env, start TMRKZ with sh start.sh, then test trusted TLS.")


if __name__ == "__main__":
    main()
