"""Files follows the selected workspace independently of project selection."""
import base64
from io import BytesIO
import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sandbox.models import Sandbox, Workspace, WorkspaceMembership
from sandbox.services import workspace_disk, workspace_disk_guest
from sandbox.services.git_service import get_shared_workspace_root, get_project_relative_path
from sandbox.services.sandbox_service import SandboxBootstrapService
from sandbox.services.project_git import initialize_project_repository


def get_local_workspace_root(project):
    folder = get_shared_workspace_root(project) / get_project_relative_path(project)
    folder.mkdir(parents=True, exist_ok=True)
    return folder


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class WorkspaceFilesTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="files-owner", email="files@example.com", password="test123")
        self.root = SandboxBootstrapService.ensure_personal_filesystem(self.user)
        self.workspace = self.root.workspace
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        settings = override_settings(LOCAL_WORKSPACE_ROOT=Path(temp.name))
        settings.enable()
        self.addCleanup(settings.disable)
        self.website = self.project("website")
        self.mobile = self.project("mobile")
        for project in (self.website, self.mobile):
            folder = get_local_workspace_root(project)
            (folder / "README.md").write_text(project.slug)
        self.get_or_create = self.enterContext(patch("sandbox.services.sandbox_session.SandboxSessionManager.get_or_create"))
        self.get_or_create.side_effect = self._runtime_for

    def _runtime_for(self, project):
        disk_root = get_shared_workspace_root(project)
        runtime = MagicMock()

        def execute(*command, **kwargs):
            if command[:2] == ("python3", "-c") and len(command) >= 4:
                request = json.loads(command[-1])
                request["root"] = str(disk_root / request["root"].removeprefix("/workspace").lstrip("/"))
                try:
                    with patch.object(workspace_disk_guest, "WORKSPACE_ROOT", disk_root), patch.object(
                        workspace_disk_guest.sys, "stdin", SimpleNamespace(buffer=BytesIO(kwargs.get("stdin", b"")))
                    ):
                        result = workspace_disk_guest.operate(request)
                except (ValueError, OSError) as exc:
                    result = {"error": str(exc)}
                proc = Mock()
                proc.stdout.read.return_value = json.dumps(result)
                proc.wait.return_value = 0
                return proc
            if command[:2] == ("bash", "-lc"):
                script = command[2].replace("/workspace", str(disk_root))
                completed = subprocess.run(["bash", "-lc", script], capture_output=True, timeout=30)
                proc = Mock()
                proc.stdout = iter([completed.stdout])
                proc.wait.return_value = completed.returncode
                return proc
            raise AssertionError(f"Unexpected command: {command}")

        runtime.exec.side_effect = execute
        return runtime

    def project(self, slug):
        return Sandbox.objects.create(user=self.user, workspace=self.workspace, slug=slug, display_name=slug, filesystem_path=f"/workspace/{slug}")

    def list_metadata(self, workspace=None):
        response = self.client.get("/sandbox/sandbox-tools/list/", {"workspace_uuid": str((workspace or self.workspace).uuid)})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_root_is_hidden_from_projects_and_stable_after_project_selection(self):
        first = self.list_metadata()
        self.assertEqual(first["workspace_sandbox"]["uuid"], str(self.root.uuid))
        self.assertEqual({item["uuid"] for item in first["sandboxes"]}, {str(self.website.uuid), str(self.mobile.uuid)})
        response = self.client.post("/sandbox/sandbox-tools/list/", {"action": "pick", "sandbox_uuid": str(self.mobile.uuid), "workspace_uuid": str(self.workspace.uuid)}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.list_metadata()["workspace_sandbox"]["uuid"], first["workspace_sandbox"]["uuid"])
        ordinary = self.client.get("/sandbox/sandboxes/", {"workspace_uuid": str(self.workspace.uuid)})
        payload = ordinary.json()
        self.assertEqual({item["uuid"] for item in (payload if isinstance(payload, list) else payload["results"])}, {str(self.website.uuid), str(self.mobile.uuid)})

    def test_files_lists_all_project_folders(self):
        response = self.client.get(f"/sandbox/sandboxes/{self.root.uuid}/files/")
        self.assertEqual(response.status_code, 200)
        paths = {item["path"] for item in response.json()}
        self.assertTrue({"/workspace/website", "/workspace/mobile", "/workspace/website/README.md", "/workspace/mobile/README.md"}.issubset(paths))
        self.assertNotIn("/workspace/default", paths)

    def test_storage_failure_does_not_serve_stale_cache(self):
        from utils.cache import set_sandbox_files
        set_sandbox_files(str(self.root.uuid), [{"path": "/workspace/website/README.md"}])
        self.get_or_create.side_effect = RuntimeError("VM unavailable")
        response = self.client.get(f"/sandbox/sandboxes/{self.root.uuid}/files/")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("README.md", str(response.json()))

    def test_full_path_read_and_write_use_the_shared_root(self):
        path = "/workspace/website/README.md"
        encoded = base64.b64encode(path.encode()).decode()
        url = f"/sandbox/sandboxes/{self.root.uuid}/files/{encoded}/content/"
        self.assertEqual(self.client.get(url).json()["content"], "website")
        response = self.client.put(url, {"content": "updated from Files"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual((get_local_workspace_root(self.website) / "README.md").read_text(), "updated from Files")
        self.assertEqual((get_local_workspace_root(self.mobile) / "README.md").read_text(), "mobile")

    def test_changing_workspace_changes_only_the_filesystem_scope(self):
        other = Workspace.objects.create(owner=self.user, name="Other", slug="other", storage_key="other-files-test")
        WorkspaceMembership.objects.create(workspace=other, user=self.user, role="owner")
        payload = self.list_metadata(other)
        other_root = Sandbox.objects.get(uuid=payload["workspace_sandbox"]["uuid"])
        self.assertNotEqual(other_root.uuid, self.root.uuid)
        self.assertEqual(payload["sandboxes"], [])
        paths = {entry["path"] for entry in workspace_disk.list_tree(other_root)}
        self.assertNotIn("/workspace/website", paths)
        self.assertEqual(self.list_metadata()["workspace_sandbox"]["uuid"], str(self.root.uuid))

    def test_create_project_requires_only_folder_path(self):
        folder = get_local_workspace_root(self.root) / "My Application"
        folder.mkdir()
        response = self.client.post("/sandbox/sandbox-tools/list/", {"action": "create", "workspace_uuid": str(self.workspace.uuid), "filesystem_path": "/workspace/My Application"}, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["display_name"], "My Application")
        self.assertEqual(response.json()["slug"], "my-application")
        self.assertTrue((folder / ".git" / "HEAD").is_file())
        self.assertEqual(subprocess.run(["git", "-C", str(folder), "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip(), str(folder))
        self.assertEqual(response.json()["filesystem_path"], "/workspace/My Application")
        self.assertEqual(self.list_metadata()["workspace_sandbox"]["uuid"], str(self.root.uuid))
        self.assertTrue((get_local_workspace_root(self.website) / "README.md").exists())

    def test_existing_projects_are_preserved_when_bootstrapping_files(self):
        self.root.delete()
        Sandbox.objects.filter(pk=self.website.pk).update(sandbox_object_id="existing-runtime")
        root = SandboxBootstrapService.ensure_workspace_sandbox(self.workspace)
        self.assertEqual(root.filesystem_path, "/workspace")
        self.assertEqual(root.sandbox_object_id, "existing-runtime")
        self.assertEqual(Sandbox.objects.filter(workspace=self.workspace).count(), 3)
        self.assertTrue((get_local_workspace_root(self.website) / "README.md").exists())
        self.assertEqual(SandboxBootstrapService.ensure_workspace_sandbox(self.workspace).uuid, root.uuid)

    def test_database_prevents_duplicate_filesystem_roots(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            Sandbox.objects.create(user=self.user, workspace=self.workspace, slug="another-root", display_name="Files", filesystem_path="/workspace")

    def create_project_at(self, path):
        return self.client.post("/sandbox/sandbox-tools/list/", {"action": "create", "workspace_uuid": str(self.workspace.uuid), "filesystem_path": path}, format="json")

    def test_project_from_clone_preserves_history_and_origin(self):
        with TemporaryDirectory() as upstream:
            subprocess.run(["git", "init", "--quiet", upstream], check=True, capture_output=True)
            subprocess.run(["git", "-C", upstream, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "--quiet", "-m", "Initial"], check=True, capture_output=True)
            folder = get_local_workspace_root(self.root) / "cloned"
            subprocess.run(["git", "clone", "--quiet", upstream, str(folder)], check=True, capture_output=True)
            config = (folder / ".git" / "config").read_bytes()
            head = subprocess.run(["git", "-C", str(folder), "rev-parse", "HEAD"], check=True, capture_output=True).stdout
            response = self.create_project_at("/workspace/cloned")
            self.assertEqual(response.status_code, 201)
            self.assertEqual((folder / ".git" / "config").read_bytes(), config)
            self.assertEqual(subprocess.run(["git", "-C", str(folder), "rev-parse", "HEAD"], check=True, capture_output=True).stdout, head)

    def test_worktree_git_file_is_preserved(self):
        folder = get_local_workspace_root(self.root) / "worktree"
        folder.mkdir()
        marker = folder / ".git"
        marker.write_text("gitdir: /existing/repository/worktrees/project\n")
        response = self.create_project_at("/workspace/worktree")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(marker.read_text(), "gitdir: /existing/repository/worktrees/project\n")

    def test_nested_project_gets_its_own_repository(self):
        parent = get_local_workspace_root(self.root) / "parent"
        subprocess.run(["git", "init", "--quiet", str(parent)], check=True, capture_output=True)
        response = self.create_project_at("/workspace/parent/child")
        self.assertEqual(response.status_code, 201)
        self.assertTrue((parent / "child" / ".git" / "HEAD").is_file())

    def test_git_failure_does_not_register_a_project(self):
        folder = get_local_workspace_root(self.root) / "failed"
        folder.mkdir()
        (folder / "notes.txt").write_text("keep me")
        runtime = MagicMock()
        runtime.exec.return_value.stdout = iter([b"git failed\n"])
        self.get_or_create.side_effect = None
        self.get_or_create.return_value = runtime
        response = self.create_project_at("/workspace/failed")
        self.assertEqual(response.status_code, 500)
        self.assertIn("Git repository", response.json()["error"])
        self.assertFalse(Sandbox.objects.filter(workspace=self.workspace, filesystem_path="/workspace/failed").exists())
        self.assertEqual((folder / "notes.txt").read_text(), "keep me")

    def test_legacy_create_endpoint_also_initializes_git(self):
        response = self.client.post("/sandbox/sandboxes/", {"workspace_uuid": str(self.workspace.uuid), "slug": "legacy", "display_name": "Legacy", "filesystem_path": "/workspace/legacy"}, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertTrue((get_local_workspace_root(self.root) / "legacy" / ".git" / "HEAD").is_file())

    def test_empty_workspace_does_not_initialize_git_or_create_projects(self):
        other = Workspace.objects.create(owner=self.user, name="Empty", slug="empty", storage_key="empty-files-test")
        WorkspaceMembership.objects.create(workspace=other, user=self.user, role="owner")
        with patch("sandbox.views.initialize_project_repository") as git:
            metadata = self.list_metadata(other)
            git.assert_not_called()
        self.assertEqual(metadata["sandboxes"], [])
        filesystem = Sandbox.objects.get(uuid=metadata["workspace_sandbox"]["uuid"])
        folder = get_local_workspace_root(filesystem)
        self.assertEqual(list(folder.iterdir()), [])

    def test_cloud_initialization_uses_workspace_runtime_and_quoted_path(self):
        project = Sandbox(user=self.user, workspace=self.workspace, slug="quoted", display_name="Quoted", filesystem_path="/workspace/it's new")
        runtime = MagicMock()
        runtime.exec.return_value.stdout = iter([b"NR_GIT_READY\n"])
        self.get_or_create.side_effect = None
        self.get_or_create.return_value = runtime
        initialize_project_repository(project)
        self.get_or_create.assert_called_once_with(self.root)
        command = runtime.exec.call_args.args[2]
        self.assertIn("git -C", command)
        self.assertIn("[ ! -e", command)
        self.assertIn("[ ! -L", command)
        self.assertIn("'\"'\"'", command)
        self.assertFalse((get_local_workspace_root(self.root) / "it's new").exists())

    def test_cloud_git_failure_preserves_the_workspace_runtime(self):
        runtime = MagicMock()
        runtime.exec.return_value.stdout = iter([b"git failed\n"])
        def connect(filesystem):
            Sandbox.objects.filter(workspace=self.workspace).update(sandbox_object_id="workspace-runtime")
            return runtime
        self.get_or_create.side_effect = connect
        response = self.create_project_at("/workspace/cloud-failed")
        self.assertEqual(response.status_code, 500)
        self.assertFalse(Sandbox.objects.filter(workspace=self.workspace, filesystem_path="/workspace/cloud-failed").exists())
        self.root.refresh_from_db()
        self.assertEqual(self.root.sandbox_object_id, "workspace-runtime")

    def test_project_path_cannot_initialize_workspace_root_or_escape_it(self):
        with patch("sandbox.views.initialize_project_repository") as git:
            for path in ("/workspace/", "/workspace/.", "/workspace/../outside"):
                with self.subTest(path=path):
                    self.assertEqual(self.create_project_at(path).status_code, 400)
            git.assert_not_called()
