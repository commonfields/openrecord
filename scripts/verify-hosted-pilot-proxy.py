#!/usr/bin/env python3
"""Validate local HTTP and hostname-based automatic HTTPS without network deployment.

Requires Docker and the caddy:2-alpine image. Only adapts configuration: does
not bind host ports, contact ACME, or request a certificate.
"""
import json
from pathlib import Path
import subprocess

config = Path(__file__).resolve().parents[1] / "deploy" / "Caddyfile"
for site, port in ((":80", ":80"), ("pilot.example.test", ":443")):
    result = subprocess.run([
        "docker", "run", "--rm", "--entrypoint", "caddy",
        "-e", f"PILOT_SITE={site}", "-v", f"{config}:/etc/caddy/Caddyfile:ro",
        "caddy:2-alpine", "adapt", "--config", "/etc/caddy/Caddyfile",
        "--adapter", "caddyfile",
    ], capture_output=True, text=True, check=True)
    adapted = json.loads(result.stdout)
    servers = adapted["apps"]["http"]["servers"]
    assert any(port in server["listen"] for server in servers.values()), adapted
    assert "api:3001" in result.stdout, "API upstream lost"
    assert "/srv/openrecord-web" in result.stdout, "SPA root lost"
    if site != ":80":
        assert not any(server.get("automatic_https", {}).get("disable")
                       for server in servers.values()), "automatic HTTPS disabled"
        assert site in result.stdout, "hostname not matched"
    print(f"PASS proxy configuration: {site} listens on {port}")
