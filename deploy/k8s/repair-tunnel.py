#!/usr/bin/env python3
"""Restore access via the in-cluster runner without rebuilding the application."""
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    root = Path(__file__).resolve().parents[2]
    values = json.loads(subprocess.check_output(
        ["helm", "-n", "team-3", "get", "values", "freespot", "-o", "json"],
        text=True,
    ))
    for component in ("backend", "frontend"):
        if not (values or {}).get(component, {}).get("tag"):
            raise RuntimeError(f"Existing {component} tag missing; refusing to change application images")
    version = subprocess.check_output(
        ["helm", "version", "--template", "{{.Version}}"], text=True,
    )
    if version.startswith("v3."):
        flags = ["--atomic", "--wait"]
    elif version.startswith("v4."):
        flags = ["--rollback-on-failure", "--wait=legacy"]
    else:
        raise RuntimeError("Helm 3 or 4 required")
    # mkstemp creates a private file; never print the release's values.
    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory) / "values.json"
        config.write_text(json.dumps(values))
        config.chmod(0o600)
        subprocess.run([
            "helm", "upgrade", "freespot", str(root / "deploy/helm/freespot"),
            "-n", "team-3", "-f", str(config), "--set", "publicTunnel.enabled=true",
            *flags, "--timeout", "10m",
        ], check=True)
    subprocess.run([
        "kubectl", "-n", "team-3", "rollout", "restart",
        "deployment/freespot-public-tunnel",
    ], check=True)
    subprocess.run([
        "kubectl", "-n", "team-3", "rollout", "status",
        "deployment/freespot-public-tunnel", "--timeout=5m",
    ], check=True)


if __name__ == "__main__":
    main()
