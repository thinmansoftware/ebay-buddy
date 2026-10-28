"""Fresh-host invocation from an unrelated working directory; synthetic data only."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CompanionCLI(unittest.TestCase):
    def invoke(self, *args, payload=None):
        with tempfile.TemporaryDirectory() as cwd:
            return subprocess.run(
                [sys.executable, str(ROOT / 'companion' / 'cli.py'), *args],
                input=json.dumps(payload) if payload is not None else '',
                text=True, capture_output=True, cwd=cwd, timeout=10,
            )

    def test_check_locates_package_without_cwd_or_secrets(self):
        result = self.invoke('check')
        self.assertEqual(result.returncode, 0, result.stderr)
        status = json.loads(result.stdout)
        self.assertTrue(status['ready'])
        self.assertEqual(Path(status['package_root']), ROOT)
        self.assertEqual(status['version'], '0.1.0-rc.10')
        self.assertNotIn('environment', status)

    def test_prepare_and_render_work_outside_package(self):
        prepared = self.invoke('prepare-brief', payload={'mailbox_id': 'synthetic-mailbox', 'messages': []})
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        brief = json.loads(prepared.stdout)
        self.assertEqual(brief['orders'], [])
        rendered = self.invoke('render-brief', payload=brief)
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        self.assertIn('No eBay notices were supplied.', rendered.stdout)

    def test_disallows_unknown_commands_without_echoing_input(self):
        result = self.invoke('../../untrusted', payload={'private': 'synthetic-input'})
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('synthetic-input', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
