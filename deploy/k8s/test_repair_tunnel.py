import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("repair_tunnel", Path(__file__).with_name("repair-tunnel.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RepairTunnelTests(unittest.TestCase):
    def test_preserves_existing_release_values(self):
        values = {"backend": {"tag": "old-backend"}, "frontend": {"tag": "old-frontend"}, "simulatorEnabled": False}
        commands = []

        def run(command, **kwargs):
            commands.append(command)
            if command[0] == "helm":
                config = Path(command[command.index("-f") + 1])
                self.assertEqual(json.loads(config.read_text()), values)
                self.assertEqual(config.stat().st_mode & 0o777, 0o600)

        with patch.object(module.subprocess, "check_output", side_effect=[json.dumps(values), "v3.18.4"]):
            with patch.object(module.subprocess, "run", side_effect=run):
                module.main()
        self.assertIn("--atomic", commands[0])
        self.assertEqual(commands[1][-1], "deployment/freespot-public-tunnel")
        self.assertEqual(len(commands), 3)

    def test_missing_image_tag_aborts_before_upgrade(self):
        with patch.object(module.subprocess, "check_output", return_value='{"backend":{"tag":"old"}}'):
            with patch.object(module.subprocess, "run") as run:
                with self.assertRaises(RuntimeError):
                    module.main()
                run.assert_not_called()
