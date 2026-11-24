"""Import uses shared storage, then registers the cloned folder as a project."""
import shlex
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from social_django.models import UserSocialAuth

from sandbox.models import Sandbox
from sandbox.services.git_service import get_shared_workspace_root
from sandbox.services.sandbox_service import SandboxBootstrapService


@override_settings(SANDBOX_PROVIDER="docker", CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class ProjectImportTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="import-owner")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.root = SandboxBootstrapService.ensure_personal_filesystem(self.user)
        self.url = f"/sandbox/sandboxes/{self.root.uuid}/git-clone/"
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        settings = override_settings(LOCAL_WORKSPACE_ROOT=self.base / "storage")
        settings.enable()
        self.addCleanup(settings.disable)
        self.workspace = get_shared_workspace_root(self.root)
        self.configure_git_patcher = patch("sandbox.views.configure_github_git")
        self.configure_git = self.configure_git_patcher.start()
        self.addCleanup(self.configure_git_patcher.stop)
        self.origin = self.base / "origin"
        self.origin.mkdir()
        self.git(self.origin, "init", "-b", "main")
        (self.origin / "README.md").write_text("imported history\n")
        self.git(self.origin, "add", "README.md")
        self.git(self.origin, "-c", "user.name=Import Test", "-c", "user.email=test@example.com", "commit", "-m", "First commit")

    def git(self, path, *args):
        return subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, text=True).stdout.strip()

    def clone(self, payload, actual=True):
        runtime = MagicMock()
        manager = MagicMock()
        manager.get_or_create.return_value = runtime
        if actual:
            def execute(*args, **kwargs):
                command = args[2].replace("https://github.com/acme/repo.git", str(self.origin)).replace("/workspace", str(self.workspace))
                result = subprocess.run(["bash", "-lc", command], capture_output=True, timeout=20)
                process = MagicMock()
                process.stdout = [result.stdout]
                process.returncode = result.returncode
                return process
            runtime.exec.side_effect = execute
        else:
            runtime.exec.return_value.stdout = [b"Cloning...\n"]
            runtime.exec.return_value.returncode = 0
        with patch("sandbox.services.sandbox_session.get_sandbox_manager", return_value=manager):
            response = self.client.post(self.url, payload, format="json")
            output = b"".join(response.streaming_content).decode() if response.streaming else response.json()
        return response, output, manager, runtime

    def test_clone_automatically_registers_project_and_preserves_history_and_runtime(self):
        self.root.sandbox_object_id = "vm-shared"
        self.root.terminal_url = "wss://terminal.example"
        self.root.terminal_token = "shared-token"
        self.root.save()
        response, output, manager, _ = self.clone({"repo_url": "acme/repo", "destination_path": "/workspace/team/My Application"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("[Success]", output)
        manager.get_or_create.assert_called_once_with(self.root)
        project = Sandbox.objects.get(workspace=self.root.workspace, filesystem_path="/workspace/team/My Application")
        self.assertEqual(project.display_name, "My Application")
        self.assertEqual(project.user, self.user)
        self.assertEqual(project.sandbox_object_id, self.root.sandbox_object_id)
        self.assertEqual(project.terminal_url, self.root.terminal_url)
        self.assertEqual(project.terminal_token, self.root.terminal_token)
        self.assertEqual(project.sandbox_cpu, self.root.sandbox_cpu)
        self.assertEqual(project.sandbox_memory, self.root.sandbox_memory)
        self.assertEqual(project.idle_timeout_seconds, self.root.idle_timeout_seconds)
        target = self.workspace / "team" / "My Application"
        self.assertEqual(self.git(target, "rev-parse", "HEAD"), self.git(self.origin, "rev-parse", "HEAD"))
        self.assertEqual(self.git(target, "branch", "--show-current"), "main")
        self.assertEqual(self.git(target, "log", "--format=%s"), "First commit")
        listed = self.client.get("/sandbox/sandbox-tools/list/", {"workspace_uuid": str(self.root.workspace_id)})
        self.assertEqual([item["uuid"] for item in listed.json()["sandboxes"]], [str(project.uuid)])

    def test_files_explorer_clone_registers_the_default_destination(self):
        _, output, _, _ = self.clone({"repo_url": "acme/repo"})
        self.assertIn("[Success]", output)
        self.assertEqual(Sandbox.objects.get(workspace=self.root.workspace, filesystem_path="/workspace/repo").display_name, "repo")

    def test_clones_with_the_same_folder_name_get_distinct_slugs(self):
        self.clone({"repo_url": "acme/repo", "destination_path": "/workspace/first/repo"})
        _, output, _, _ = self.clone({"repo_url": "acme/repo", "destination_path": "/workspace/second/repo"})
        self.assertIn("[Success]", output)
        projects = Sandbox.objects.filter(workspace=self.root.workspace).exclude(pk=self.root.pk)
        self.assertEqual(projects.count(), 2)
        self.assertEqual(set(projects.values_list("slug", flat=True)), {"repo", "repo-1"})

    def test_existing_project_at_clone_destination_is_reused(self):
        existing = Sandbox.objects.create(user=self.user, workspace=self.root.workspace, slug="registered", display_name="Registered", filesystem_path="/workspace/repo")
        _, output, _, _ = self.clone({"repo_url": "acme/repo"})
        self.assertIn("[Success]", output)
        self.assertEqual(Sandbox.objects.filter(workspace=self.root.workspace).count(), 2)
        existing.refresh_from_db()
        self.assertEqual(existing.display_name, "Registered")

    def test_registration_failure_does_not_report_success_or_remove_the_clone(self):
        with patch("sandbox.views._register_cloned_project", side_effect=RuntimeError("Database unavailable")):
            _, output, _, _ = self.clone({"repo_url": "acme/repo"})
        self.assertIn("[Error]", output)
        self.assertIn("Add this folder as an existing project", output)
        self.assertNotIn("[Success]", output)
        self.assertTrue((self.workspace / "repo" / ".git").is_dir())
        self.assertEqual(Sandbox.objects.filter(workspace=self.root.workspace).count(), 1)

    def test_invalid_destinations_do_not_start_runtime(self):
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            for path in ("/workspace", "/workspace/../outside", "/workspace/repo/.git/objects", "/workspace/back\\slash", "/workspace/null\0", 123):
                with self.subTest(path=path):
                    response = self.client.post(self.url, {"repo_url": "acme/repo", "destination_path": path}, format="json")
                    self.assertEqual(response.status_code, 400)
            factory.assert_not_called()

    def test_clone_does_not_overwrite_existing_folder(self):
        target = self.workspace / "repo"
        target.mkdir()
        (target / "important.txt").write_text("keep me")
        response, output, _, _ = self.clone({"repo_url": "acme/repo", "destination_path": "/workspace/repo"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("[Error]", output)
        self.assertNotIn("[Success]", output)
        self.assertEqual((target / "important.txt").read_text(), "keep me")
        self.assertEqual(Sandbox.objects.filter(workspace=self.root.workspace).count(), 1)

    def test_symlink_destination_cannot_escape_shared_storage(self):
        outside = self.base / "outside"
        outside.mkdir()
        (self.workspace / "link").symlink_to(outside, target_is_directory=True)
        _, output, _, _ = self.clone({"repo_url": "acme/repo", "destination_path": "/workspace/link/repo"})
        self.assertIn("[Error]", output)
        self.assertFalse((outside / "repo").exists())
        self.assertEqual(Sandbox.objects.filter(workspace=self.root.workspace).count(), 1)

    def test_private_repository_credentials_are_removed_from_origin(self):
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="import-github", extra_data={"access_token": "test-only-private-token"})
        _, _, _, runtime = self.clone({"repo_url": "https://github.com/acme/repo.with.dots.git", "destination_path": "/workspace/repo"}, actual=False)
        command = runtime.exec.call_args.args[2]
        self.assertIn("x-access-token:test-only-private-token@github.com/acme/repo.with.dots.git", command)
        self.assertIn("remote set-url origin https://github.com/acme/repo.with.dots.git", command)

    def test_private_repository_configures_push_credentials_and_fork_upstream(self):
        UserSocialAuth.objects.create(
            user=self.user,
            provider="github",
            uid="import-github",
            extra_data={"access_token": "test-only-private-token", "login": "octocat", "email": "octocat@example.com"},
        )
        with patch("sandbox.views._github_fork_parent", return_value="https://github.com/upstream/repo.git"):
            _, output, _, runtime = self.clone(
                {"repo_url": "https://github.com/acme/repo.git", "destination_path": "/workspace/repo"},
                actual=False,
            )
        self.assertIn("[Success]", output)
        self.configure_git.assert_called_once()
        args, kwargs = self.configure_git.call_args
        self.assertIs(args[0], runtime)
        self.assertEqual(args[1], "test-only-private-token")
        self.assertEqual(kwargs["user_name"], "octocat")
        self.assertEqual(kwargs["user_email"], "octocat@example.com")
        self.assertEqual(kwargs["target_path"], "/workspace/repo")
        self.assertEqual(kwargs["upstream_url"], "https://github.com/upstream/repo.git")

    def test_runtime_start_failure_returns_an_error_without_registering_project(self):
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            factory.return_value.get_or_create.side_effect = RuntimeError("Docker launch failed")
            response = self.client.post(self.url, {"repo_url": "acme/repo", "destination_path": "/workspace/repo"}, format="json")
        self.assertEqual(response.status_code, 500)
        self.assertIn("Failed to clone", response.json()["error"])
        self.assertEqual(Sandbox.objects.filter(workspace=self.root.workspace).count(), 1)
