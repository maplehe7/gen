from __future__ import annotations

import argparse
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest import mock

import unity_standalone
from unity_standalone import DetectedBuild, DetectedEntry


class UnityProbeTest(unittest.TestCase):
    def make_args(self, entry_url: str) -> argparse.Namespace:
        return argparse.Namespace(
            entry_url=entry_url,
            loader_url="",
            framework_url="",
            data_url="",
            wasm_url="",
            out_dir="",
            overwrite=False,
            launch_options="both",
            recommended_launch="none",
            probe_only=True,
        )

    @mock.patch("unity_standalone.detect_entry_build")
    @mock.patch("unity_standalone.find_supported_entry")
    def test_probe_payload_reports_supported_unity_build(self, mock_find_supported_entry, mock_detect_entry_build) -> None:
        mock_find_supported_entry.return_value = DetectedEntry(
            entry_kind="unity",
            index_url="https://geometrydash-lite.io/",
            index_html="<html></html>",
            source_page_url="https://geometrydash-lite.io/",
        )
        mock_detect_entry_build.return_value = DetectedBuild(
            build_kind="modern",
            index_url="https://geometrydash-lite.io/",
            index_html="<html></html>",
            loader_url="https://geometrydash-lite.io/Build/game.loader.js",
            candidates={"loader": ["https://geometrydash-lite.io/Build/game.loader.js"]},
        )

        plan = unity_standalone.resolve_export_plan(
            self.make_args("https://geometrydash-lite.io/"),
            "both",
            "none",
            resolve_direct_assets=False,
            allow_unsupported_entry=True,
        )
        payload = unity_standalone.build_probe_payload_from_plan(plan)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["buildable"])
        self.assertEqual(payload["entry_kind"], "unity")
        self.assertEqual(payload["build_kind"], "modern")

    @mock.patch("unity_standalone.find_supported_entry")
    def test_probe_payload_reports_remote_stream_as_unbuildable(self, mock_find_supported_entry) -> None:
        mock_find_supported_entry.return_value = DetectedEntry(
            entry_kind="remote_stream",
            index_url="https://unsupported.example/app",
            index_html="<html></html>",
            source_page_url="https://unsupported.example/app",
            metadata={"app_name": "Unsupported"},
        )

        plan = unity_standalone.resolve_export_plan(
            self.make_args("https://unsupported.example/app"),
            "both",
            "none",
            resolve_direct_assets=False,
            allow_unsupported_entry=True,
        )
        payload = unity_standalone.build_probe_payload_from_plan(plan)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["buildable"])
        self.assertEqual(payload["entry_kind"], "remote_stream")
        self.assertIn("Remote stream entries are disabled", payload["reason"])

    @mock.patch("unity_standalone.find_supported_entry")
    def test_probe_only_main_prints_machine_readable_json(self, mock_find_supported_entry) -> None:
        mock_find_supported_entry.return_value = DetectedEntry(
            entry_kind="remote_stream",
            index_url="https://unsupported.example/app",
            index_html="<html></html>",
            source_page_url="https://unsupported.example/app",
            metadata={"app_name": "Unsupported"},
        )

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            exit_code = unity_standalone.main(["https://unsupported.example/app", "--probe-only"])

        payload = json.loads(buffer.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertFalse(payload["buildable"])
        self.assertEqual(payload["entry_kind"], "remote_stream")
