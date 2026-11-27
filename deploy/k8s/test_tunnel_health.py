import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


class TunnelHealthTests(unittest.TestCase):
    def probe(self, logs):
        template = (Path(__file__).parents[1] / "helm/freespot/templates/public-tunnel.yaml").read_text()
        script = textwrap.dedent(template.split("  health.sh: |\n", 1)[1].split("  default.conf:", 1)[0])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "tunnel.log"
            log.write_text(logs)
            script = script.replace("/tmp/tunnel.log", str(log)).replace("{{ .Values.rootPath }}", "/team-3")
            wget = root / "wget"
            wget.write_text(
                "#!/bin/sh\n"
                "for arg; do\n"
                '  if [ "$arg" = "https://working.app.lhr.life/team-3/ready" ]; then\n'
                "    echo '{\"status\":\"ok\"}'\n"
                "    exit 0\n"
                "  fi\n"
                "done\n"
                "exit 4\n"
            )
            wget.chmod(0o700)
            return subprocess.run(
                ["sh", "-c", script],
                env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]},
                capture_output=True,
            ).returncode

    def event(self, address):
        return json.dumps({"type": "run.localhost.tunnel.registered", "data": {"address": address}})

    def test_live_public_route_is_healthy(self):
        self.assertEqual(self.probe(self.event("working.app.lhr.life")), 0)

    def test_expired_public_route_is_unhealthy_despite_registration(self):
        self.assertNotEqual(self.probe(self.event("expired.app.lhr.life")), 0)

    def test_banner_is_not_healthy(self):
        self.assertNotEqual(self.probe("https://admin.localhost.run/"), 0)

    def test_latest_registration_wins(self):
        logs = self.event("expired.app.lhr.life") + "\n" + self.event("working.app.lhr.life")
        self.assertEqual(self.probe(logs), 0)

    def test_untrusted_hostname_is_rejected(self):
        self.assertNotEqual(self.probe(self.event("working.app.lhr.life.attacker.example")), 0)
