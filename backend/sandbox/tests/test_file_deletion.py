"""Deletion removes the actual subtree on the workspace VM disk."""
import base64
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sandbox.services import volume_tools, workspace_disk_guest
from sandbox.services.git_service import get_shared_workspace_root
from sandbox.services.sandbox_service import SandboxBootstrapService


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class FileDeletionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="deletion-owner")
        self.root = SandboxBootstrapService.ensure_personal_filesystem(self.user)
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        storage = override_settings(LOCAL_WORKSPACE_ROOT=Path(temporary.name))
        storage.enable()
        self.addCleanup(storage.disable)
        self.disk_root = get_shared_workspace_root(self.root)
        self.folder = self.disk_root / "folder"
        (self.folder / "nested").mkdir(parents=True)
        (self.folder / "nested" / "hello.py").write_text("print('hello')")
        sibling = self.folder.with_name("folder-other")
        sibling.mkdir()
        (sibling / "keep.txt").write_text("keep")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.runtime = MagicMock()

        def execute(*command, **kwargs):
            request = json.loads(command[-1])
            request["root"] = str(self.disk_root / request["root"].removeprefix("/workspace").lstrip("/"))
            try:
                with patch.object(workspace_disk_guest, "WORKSPACE_ROOT", self.disk_root), patch.object(
                    workspace_disk_guest.sys, "stdin", SimpleNamespace(buffer=BytesIO(kwargs.get("stdin", b"")))
                ):
                    result = workspace_disk_guest.operate(request)
            except (ValueError, OSError) as exc:
                result = {"error": str(exc)}
            proc = Mock()
            proc.stdout.read.return_value = json.dumps(result)
            proc.wait.return_value = 0
            return proc

        self.runtime.exec.side_effect = execute
        self.get_or_create = self.enterContext(patch("sandbox.services.sandbox_session.SandboxSessionManager.get_or_create", return_value=self.runtime))

    def delete(self, path="/workspace/folder"):
        encoded = base64.urlsafe_b64encode(path.encode()).decode()
        return self.client.delete(f"/sandbox/sandboxes/{self.root.uuid}/files/{encoded}/")

    def test_folder_and_descendants_are_removed_from_disk_and_listing(self):
        self.assertEqual(self.delete().status_code, 204)
        self.assertFalse(self.folder.exists())
        paths = {item["path"] for item in self.client.get(f"/sandbox/sandboxes/{self.root.uuid}/files/").json()}
        self.assertFalse(any(path == "/workspace/folder" or path.startswith("/workspace/folder/") for path in paths))
        self.assertIn("/workspace/folder-other/keep.txt", paths)

    def test_storage_operation_error_is_propagated(self):
        with patch.object(workspace_disk_guest.shutil, "rmtree", side_effect=OSError("Permission denied")):
            response = self.delete()
        self.assertEqual(response.status_code, 500)
        self.assertIn("Permission denied", response.json()["error"])
        self.assertTrue((self.folder / "nested" / "hello.py").exists())

    def test_unsafe_paths_leave_workspace_and_siblings_intact(self):
        for path in ("/workspace", "/workspace/", "/workspace/../outside", "/workspace/folder/../folder-other", "/tmp/outside"):
            with self.subTest(path=path):
                self.assertEqual(self.delete(path).status_code, 500)
        self.assertTrue(self.folder.exists())
        self.assertTrue(self.folder.with_name("folder-other").exists())

    def test_unicode_folder_name_is_decoded_and_deleted(self):
        target = self.folder.with_name("çalışma-資料")
        target.mkdir()
        (target / "file.py").write_text("unicode")
        self.assertEqual(self.delete("/workspace/çalışma-資料").status_code, 204)
        self.assertFalse(target.exists())
