"""Tools in existing chats must never recreate a legacy default project."""
import json
from pathlib import Path
from subprocess import CompletedProcess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation
from sandbox.services import file_tools
from sandbox.services.docker_sandbox import ensure_docker_sandbox
from sandbox.services.git_service import SandboxGitService
from sandbox.services.sandbox_service import SandboxBootstrapService


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class NoDefaultProjectToolsTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="nodefault-user")
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.conversation = Conversation.objects.create(user=self.user, workspace=self.workspace)

    def test_tools_use_workspace_root_without_creating_default_directory_or_project(self):
        root = SandboxBootstrapService.ensure_workspace_sandbox(self.workspace)
        root.conversations.add(self.conversation)
        client = APIClient()
        client.force_authenticate(self.user)
        with TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
            def execute(sandbox, name, arguments):
                self.assertEqual(sandbox.pk, root.pk)
                self.assertEqual(sandbox.filesystem_path, "/workspace")
                return file_tools.dispatch_file_tool(name, arguments)
            with patch("sandbox.services.sandbox_session.get_sandbox_manager") as manager:
                manager.return_value.execute_tool.side_effect = execute
                response = client.post("/tools/execute/", {
                    "name": "file_write", "arguments": {"path": "hello.py", "content": "print('Hello')"},
                    "conversation_id": str(self.conversation.pk),
                }, format="json")
                self.assertEqual(response.status_code, 200)
                self.assertNotIn("error", response.data["result"])
                result = json.loads(execute_builtin_tool(self.user, "shell_exec", {"command": "python3 hello.py"}, self.conversation))
                self.assertEqual(result["exit_code"], 0)
                self.assertEqual(result["stdout"].strip(), "Hello")
            self.assertTrue((Path(directory) / "hello.py").exists())
            self.assertFalse((Path(directory) / "default").exists())
            self.assertFalse((Path(directory) / ".git").exists())
        self.assertFalse(self.workspace.projects.exclude(filesystem_path="/workspace").exists())
        payload = client.get("/sandbox/sandbox-tools/list/", {"workspace_uuid": str(self.workspace.pk)}).json()
        self.assertEqual(payload["sandboxes"], [])


class NoImplicitProjectDirectoryTests(SimpleTestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.project = SimpleNamespace(
            uuid="legacy", slug="default", filesystem_path="/workspace/default",
            workspace_id="team", workspace=SimpleNamespace(storage_key="team"),
            user_id="owner", sandbox_cpu=0.5, sandbox_memory=2048,
        )

    def test_docker_start_creates_only_workspace_root(self):
        with override_settings(LOCAL_WORKSPACE_ROOT=self.directory), patch("sandbox.services.docker_sandbox.subprocess.run", return_value=CompletedProcess([], 0, "true\n", "")):
            ensure_docker_sandbox(self.project)
        self.assertTrue((self.directory / "team").is_dir())
        self.assertFalse((self.directory / "team" / "default").exists())

    def test_checkpoint_and_diff_do_not_recreate_missing_project_directory(self):
        with override_settings(LOCAL_WORKSPACE_ROOT=self.directory), patch("sandbox.services.git_service.subprocess.run") as run:
            self.assertIsNone(SandboxGitService.create_checkpoint(self.project))
            self.assertFalse(SandboxGitService.get_diff(self.project)["has_changes"])
            run.assert_not_called()
        self.assertFalse((self.directory / "team" / "default").exists())

    def test_projectless_checkpoint_and_diff_do_not_init_workspace_git(self):
        self.project.filesystem_path = "/workspace"
        with override_settings(LOCAL_WORKSPACE_ROOT=self.directory), patch("sandbox.services.git_service.subprocess.run") as run:
            self.assertIsNone(SandboxGitService.create_checkpoint(self.project))
            self.assertFalse(SandboxGitService.get_diff(self.project)["has_changes"])
            run.assert_not_called()
        self.assertFalse((self.directory / "team" / ".git").exists())

    def test_shell_missing_cwd_returns_error_and_does_not_run_or_create_directory(self):
        with patch.object(file_tools, "WORKSPACE_ROOT", str(self.directory)):
            result = file_tools.shell_exec("touch should-not-run.txt", cwd="default")
        self.assertNotEqual(result["exit_code"], 0)
        self.assertIn("Working directory not found", result["stderr"])
        self.assertFalse((self.directory / "default").exists())
        self.assertFalse((self.directory / "should-not-run.txt").exists())
