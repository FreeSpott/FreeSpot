#!/usr/bin/env python3
"""Read the URL from the current (not a previous container's) tunnel logs."""
import json
import re
import subprocess


def public_url(logs):
    address = None
    for line in logs.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "run.localhost.tunnel.registered":
            continue
        candidate = event.get("data", {}).get("address", "")
        if re.fullmatch(r"[a-z0-9-]+(?:\.app)?\.(?:lhr\.life|localhost\.run)", candidate):
            address = candidate
    if address is None:
        raise ValueError("Public tunnel URL not found in current container logs")
    return "https://" + address + "/team-3/"


if __name__ == "__main__":
    logs = subprocess.check_output(
        ["kubectl", "-n", "team-3", "logs", "deployment/freespot-public-tunnel",
         "-c", "tunnel"], text=True, timeout=30,
    )
    print(public_url(logs))
