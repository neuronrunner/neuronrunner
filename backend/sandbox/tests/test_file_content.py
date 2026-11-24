"""Authenticated previews preserve image bytes and support Unicode file paths."""
import base64
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from sandbox.views import SandboxFileContentView


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class FileContentTests(SimpleTestCase):
    def read(self, path, contents, *, urlsafe=True):
        encode = base64.urlsafe_b64encode if urlsafe else base64.b64encode
        file_id = encode(path.encode("utf-8")).decode("ascii")
        request = APIRequestFactory().get("/preview/")
        force_authenticate(request, user=SimpleNamespace(is_authenticated=True, pk=1))
        with patch("sandbox.views._get_accessible_project", return_value=SimpleNamespace(uuid="workspace-root")), patch("sandbox.views._has_running_vm", return_value=True), patch("sandbox.services.volume_tools.read_file", return_value=contents) as reader:
            response = SandboxFileContentView.as_view()(request, sandbox_uuid="workspace-root", file_id=file_id)
        return response, reader

    def test_jpg_and_png_contents_are_returned_as_lossless_base64(self):
        for path, binary in (("/workspace/photo.jpg", b"\xff\xd8\xff\xe0\x00\x10JFIF\xff\xd9"), ("/workspace/logo.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")):
            with self.subTest(path=path):
                response, reader = self.read(path, binary)
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.data["is_binary"])
                self.assertEqual(base64.b64decode(response.data["content"]), binary)
                self.assertEqual(reader.call_args.args[1], path)

    def test_unicode_and_urlsafe_ids_reach_the_correct_workspace_file(self):
        path = "/workspace/çalışma-資料-ÿ.png"
        response, reader = self.read(path, b"\x89PNG")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["path"], path)
        self.assertEqual(reader.call_args.args[1], path)

    def test_existing_text_files_and_standard_base64_ids_still_work(self):
        response, reader = self.read("/workspace/README.md", "çalışma".encode(), urlsafe=False)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["is_binary"])
        self.assertEqual(response.data["content"], "çalışma")

    def test_missing_and_oversized_previews_report_errors(self):
        response, _ = self.read("/workspace/missing.png", None)
        self.assertEqual(response.status_code, 404)
        response, _ = self.read("/workspace/large.jpg", b"\xff" * (SandboxFileContentView.MAX_SIZE_BYTES + 1))
        self.assertEqual(response.status_code, 413)

    def test_anonymous_preview_never_reads_workspace_storage(self):
        request = APIRequestFactory().get("/preview/")
        with patch("sandbox.services.volume_tools.read_file") as reader:
            response = SandboxFileContentView.as_view()(request, sandbox_uuid="workspace-root", file_id="image")
        self.assertIn(response.status_code, (401, 403))
        reader.assert_not_called()
