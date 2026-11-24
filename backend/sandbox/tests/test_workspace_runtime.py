"""Regression coverage for shared Docker runtimes and conversation-scoped tools."""
import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation, Tool
from chat.services.chat_service import ChatService
from sandbox.models import Sandbox, Workspace, WorkspaceMembership
from sandbox.services.docker_sandbox import get_sandbox_container_name
from sandbox.services.sandbox_service import SandboxBootstrapService
from sandbox.services.sandbox_session import SandboxSessionManager, _session_key
from utils.cache import clear_sandbox_status, set_sandbox_status


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}, SANDBOX_PROVIDER="docker")
class WorkspaceRuntimeTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user(username="runtime-owner", email="runtime-owner@example.com", password="test123")
        self.member = get_user_model().objects.create_user(username="runtime-member", email="runtime-member@example.com", password="test123")
        self.project = SandboxBootstrapService.ensure_personal_filesystem(self.owner)
        self.workspace = self.project.workspace
        self.second = Sandbox.objects.create(
            user=self.member, workspace=self.workspace, slug="shared", display_name="Shared", filesystem_path="/workspace/shared",
        )
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.member, role="member")
        self.conversation = Conversation.objects.create(user=self.member)
        self.second.conversations.add(self.conversation)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.addCleanup(self.clear_statuses)

    def clear_statuses(self):
        for project_uuid in Sandbox.objects.values_list("uuid", flat=True):
            clear_sandbox_status(str(project_uuid))

    def fake_runtime(self, object_id="nr-sandbox-workspace-shared"):
        runtime = MagicMock()
        runtime.object_id = object_id
        runtime.sandbox_id.return_value = object_id
        runtime.poll.return_value = None
        runtime.exec.return_value.stdout.read.return_value = b""
        return runtime

    def spawn(self, manager, project, runtime):
        def create(project, region=None):
            Sandbox.objects.filter(workspace=project.workspace).update(sandbox_object_id=runtime.sandbox_id())
            project.sandbox_object_id = runtime.sandbox_id()
            return runtime
        with patch.object(manager, "_create_sandbox", side_effect=create) as create_mock:
            self.assertIs(manager.get_or_create(project), runtime)
        return create_mock

    def test_projects_and_members_share_one_runtime(self):
        runtime = self.fake_runtime()
        manager = SandboxSessionManager()
        self.spawn(manager, self.project, runtime).assert_called_once()
        with patch.object(manager, "_create_sandbox") as create:
            self.assertIs(manager.get_or_create(self.second), runtime)
            create.assert_not_called()
        self.assertEqual(len(manager._sessions), 1)
        self.assertEqual(get_sandbox_container_name(self.project), get_sandbox_container_name(self.second))

    def test_release_clears_connection_for_every_project(self):
        manager = SandboxSessionManager()
        runtime = self.fake_runtime()
        self.spawn(manager, self.project, runtime)
        manager.close_session_immediately(self.second)
        runtime.terminate.assert_called_once()
        self.assertFalse(Sandbox.objects.filter(workspace=self.workspace, sandbox_last_active_at__isnull=False).exists())
        self.assertEqual(manager._sessions, {})

    def test_other_project_ping_prevents_cleanup(self):
        manager = SandboxSessionManager()
        runtime = self.fake_runtime()
        self.spawn(manager, self.project, runtime)
        Sandbox.objects.filter(workspace=self.workspace).update(sandbox_last_active_at=timezone.now() - timedelta(hours=1))
        set_sandbox_status(str(self.project.pk), {"last_active": 0, "idle_timeout": 10})
        manager.update_activity(str(self.second.pk))
        manager.cleanup_all_idle()
        runtime.terminate.assert_not_called()

    def test_workspaces_have_different_docker_containers(self):
        other = Workspace.objects.create(owner=self.owner, name="Other", slug="other")
        project = SandboxBootstrapService.ensure_workspace_sandbox(other)
        self.assertNotEqual(get_sandbox_container_name(self.project), get_sandbox_container_name(project))
        self.assertNotEqual(_session_key(self.project), _session_key(project))

    def test_workspace_bootstrap_is_idempotent_and_uses_workspace_owner(self):
        empty = Workspace.objects.create(owner=self.owner, name="Empty", slug="empty")
        first = SandboxBootstrapService.ensure_workspace_sandbox(empty)
        second = SandboxBootstrapService.ensure_workspace_sandbox(empty)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(empty.projects.count(), 1)
        self.assertEqual(first.user, self.owner)

    def test_pick_empty_workspace_does_not_fall_back_to_personal(self):
        empty = Workspace.objects.create(owner=self.owner, name="Empty", slug="empty")
        WorkspaceMembership.objects.create(workspace=empty, user=self.owner, role="owner")
        response = self.client.post("/sandbox/sandbox-tools/list/", {"action": "pick", "workspace_uuid": str(empty.pk)}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["workspace_uuid"], str(empty.pk))

    def test_tool_uses_conversation_project_ignoring_requested_sandbox(self):
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            factory.return_value.execute_tool.return_value = {"ok": True}
            result = execute_builtin_tool(self.member, "file_read", {"path": "a.txt", "sandbox_uuid": str(self.project.pk), "_sandbox_uuid": str(self.project.pk)}, self.conversation)
            self.assertEqual(json.loads(result), {"ok": True})
            args = factory.return_value.execute_tool.call_args.args
            self.assertEqual(args[0].pk, self.second.pk)
            self.assertEqual(args[2], {"path": "a.txt"})

    def test_team_member_can_execute_tool_in_owners_project(self):
        self.second.conversations.remove(self.conversation)
        self.project.conversations.add(self.conversation)
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            factory.return_value.execute_tool.return_value = {"ok": True}
            result = execute_builtin_tool(self.member, "file_read", {"path": "a.txt"}, self.conversation)
            self.assertEqual(json.loads(result), {"ok": True})
            self.assertEqual(factory.return_value.execute_tool.call_args.args[0].pk, self.project.pk)

    def test_unlinked_conversation_cannot_access_most_recent_workspace(self):
        unlinked = Conversation.objects.create(user=self.owner)
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            result = json.loads(execute_builtin_tool(self.owner, "shell_exec", {"command": "ls", "_sandbox_uuid": str(self.project.pk)}, unlinked))
            self.assertIn("no workspace attached", result["error"])
            factory.assert_not_called()

    def test_sandbox_selection_tools_are_unavailable(self):
        for name in ("sandbox_create", "sandbox_list", "sandbox_use"):
            result = json.loads(execute_builtin_tool(self.owner, name, {}, self.conversation))
            self.assertIn("automatically", result["error"])

    def test_old_catalog_and_user_supplied_tools_cannot_expose_sandbox_selection(self):
        Tool.objects.create(name="sandbox_use", description="Old selector", enabled=True, is_builtin=True)
        Tool.objects.create(name="file_read", description="Read", enabled=True, is_builtin=True, parameters_schema={"type": "object", "properties": {"path": {"type": "string"}, "sandbox_uuid": {"type": "string"}}, "required": ["path", "sandbox_uuid"]})
        service = ChatService.__new__(ChatService)
        service.conversation = self.conversation
        service.tools = [{"type": "function", "function": {"name": "sandbox_list"}}]
        service._get_mcp_tools = lambda: []
        tools = service._merge_mcp_tools()
        names = [tool["function"]["name"] for tool in tools]
        self.assertIn("file_read", names)
        self.assertFalse(set(names) & {"sandbox_use", "sandbox_list", "sandbox_create"})
        parameters = next(tool["function"]["parameters"] for tool in tools if tool["function"]["name"] == "file_read")
        self.assertNotIn("sandbox_uuid", parameters["properties"])
        self.assertEqual(parameters["required"], ["path"])

    def test_git_clone_targets_selected_project_and_reports_exit_status(self):
        runtime = MagicMock()
        process = runtime.exec.return_value
        process.stdout = [b"Cloning...\n"]
        process.returncode = 0
        manager = MagicMock()
        manager.get_or_create.return_value = runtime
        with patch("sandbox.services.sandbox_session.get_sandbox_manager", return_value=manager):
            response = self.client.post(f"/sandbox/sandboxes/{self.second.pk}/git-clone/", {"repo_url": "owner/example"}, format="json")
            output = b"".join(response.streaming_content).decode()
        self.assertIn("[Success]", output)
        self.assertIn("/workspace/shared/example", runtime.exec.call_args.args[2])
        self.assertNotIn("pty", runtime.exec.call_args.kwargs)
        manager._sync_file_tree_to_db.assert_called_once()

    def test_git_clone_nonzero_exit_is_streamed_as_error(self):
        runtime = MagicMock()
        runtime.exec.return_value.stdout = [b"fatal: repository not found\n"]
        runtime.exec.return_value.returncode = 128
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            factory.return_value.get_or_create.return_value = runtime
            response = self.client.post(f"/sandbox/sandboxes/{self.second.pk}/git-clone/", {"repo_url": "owner/example"}, format="json")
            output = b"".join(response.streaming_content).decode()
        self.assertIn("[Error]", output)
        self.assertNotIn("[Success]", output)

    def test_sync_chat_tool_loop_receives_conversation_workspace(self):
        service = ChatService.__new__(ChatService)
        service.conversation = self.conversation
        service.current_request = None
        service._start_title_generation = MagicMock(return_value=None)
        service._settle_round = MagicMock()
        service._check_workspace_balance = MagicMock()
        service.model_tag = SimpleNamespace(is_external=True)
        service.messages = []
        service._persist_token_snapshot = MagicMock()
        service._start_memory_thread = MagicMock()
        service._raise_if_canceled = MagicMock()
        service._save_response = MagicMock(return_value={"ok": True})
        service._generate_external_sync = MagicMock(side_effect=[
            ("", "", 1, 1, [{"id": "tool-1", "function": {"name": "file_read", "arguments": '{"path":"readme.txt"}'}}]),
            ("Done", "", 1, 1, []),
        ])
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            factory.return_value.execute_tool.return_value = {"content": "Hello"}
            self.assertEqual(service.generate_sync(), {"ok": True})
            self.assertEqual(factory.return_value.execute_tool.call_args.args[0].pk, self.second.pk)

    def test_tool_api_resolves_workspace_from_accessible_conversation(self):
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            factory.return_value.execute_tool.return_value = {"ok": True}
            response = self.client.post("/tools/execute/", {"name": "file_read", "arguments": {"path": "readme.txt"}, "conversation_id": str(self.conversation.pk)}, format="json")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["result"], {"ok": True})
            self.assertEqual(factory.return_value.execute_tool.call_args.args[0].pk, self.second.pk)

    def test_tool_api_rejects_inaccessible_conversation(self):
        outsider = get_user_model().objects.create_user(username="outsider-runtime", email="outsider-runtime@example.com")
        conversation = Conversation.objects.create(user=outsider)
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as factory:
            response = self.client.post("/tools/execute/", {"name": "file_read", "arguments": {"path": "readme.txt"}, "conversation_id": str(conversation.pk)}, format="json")
            self.assertEqual(response.status_code, 404)
            factory.assert_not_called()
