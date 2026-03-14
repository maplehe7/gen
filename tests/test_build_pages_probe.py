from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_pages_site


class BuildPagesProbeTest(unittest.TestCase):
    def test_build_export_fails_fast_when_probe_rejects_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dist_dir = Path(temp_dir)
            with mock.patch.object(
                build_pages_site,
                "probe_export_target",
                return_value={"ok": False, "buildable": False, "reason": "Remote stream entries are disabled."},
            ), mock.patch.object(subprocess, "run") as mock_run:
                with self.assertRaisesRegex(RuntimeError, "Remote stream entries are disabled"):
                    build_pages_site.build_export(
                        dist_dir=dist_dir,
                        source_url="https://unsupported.example/app",
                        display_name="Unsupported",
                        request_id="probe-test",
                    )

        mock_run.assert_not_called()
