import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("public_url", Path(__file__).with_name("public-url.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicURLTests(unittest.TestCase):
    def event(self, address):
        return json.dumps({"type": "run.localhost.tunnel.registered", "data": {"address": address}})

    def test_extracts_tunnel_not_documentation_link(self):
        logs = "https://admin.localhost.run/\n" + self.event("abc123.app.lhr.life")
        self.assertEqual(module.public_url(logs), "https://abc123.app.lhr.life/team-3/")

    def test_missing_url_fails(self):
        with self.assertRaises(ValueError):
            module.public_url("tunnel not started")

    def test_latest_url(self):
        logs = self.event("old-url.localhost.run") + "\n" + self.event("new-url.lhr.life")
        self.assertEqual(module.public_url(logs), "https://new-url.lhr.life/team-3/")

    def test_banner_alone_is_not_a_ready_tunnel(self):
        with self.assertRaises(ValueError):
            module.public_url("https://admin.localhost.run/")

    def test_untrusted_hostname_rejected(self):
        with self.assertRaises(ValueError):
            module.public_url(self.event("demo.lhr.life.attacker.example"))
