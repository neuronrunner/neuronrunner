from importlib import import_module
import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.apps import apps
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from chat.builtin_tools import BUILTIN_TOOLS, execute_builtin_tool
from chat.constants import HTTP_REQUEST_TOOL_DESCRIPTION
from chat.models import Conversation, Tool
from chat.services.chat_service import ChatService
from chat.tools import list_registered
from sandbox.models import Sandbox
from sandbox.services.file_tools import dispatch_file_tool
from sandbox.services.sandbox_service import SandboxBootstrapService


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class SandboxWebRequestTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="sandbox-web-user", email="web@example.com")
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.root = SandboxBootstrapService.ensure_workspace_sandbox(self.workspace)
        self.conversation = Conversation.objects.create(user=self.user)
        self.root.conversations.add(self.conversation)

    def service(self):
        service = ChatService.__new__(ChatService)
        service.conversation = self.conversation
        service.tools = None
        service._get_mcp_tools = lambda: []
        return service

    def test_tool_list_excludes_web_fetch_from_enabled_database_and_incoming_tools(self):
        Tool.objects.create(name="web_fetch", description="Legacy", parameters_schema={}, enabled=True, is_builtin=True)
        Tool.objects.create(name="http_request", description="Sandbox HTTP", parameters_schema={"type": "object", "properties": {}}, enabled=True, is_builtin=True)
        service = self.service()
        service.tools = [{"type": "function", "function": {"name": "web_fetch"}}]
        names = [tool["function"]["name"] for tool in service._merge_mcp_tools()]
        self.assertNotIn("web_fetch", names)
        self.assertIn("http_request", names)
        self.assertNotIn("web_fetch", list_registered())
        self.assertNotIn("web_fetch", [tool["function"]["name"] for tool in BUILTIN_TOOLS])

    def test_http_request_uses_shared_workspace_without_creating_project_or_backend_fetch(self):
        before = Sandbox.objects.count()
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as manager, patch("requests.request") as backend_fetch:
            manager.return_value.execute_tool.return_value = {"status_code": 200, "body": "Web response"}
            result = json.loads(execute_builtin_tool(self.user, "http_request", {"url": "https://api.github.com/repos", "sandbox_uuid": "forged"}, self.conversation))
            sandbox, name, arguments = manager.return_value.execute_tool.call_args.args
            self.assertEqual(sandbox.pk, self.root.pk)
            self.assertEqual(name, "http_request")
            self.assertEqual(arguments, {"url": "https://api.github.com/repos"})
            self.assertEqual(result["body"], "Web response")
            backend_fetch.assert_not_called()
        self.assertEqual(Sandbox.objects.count(), before)
        self.assertFalse(self.workspace.projects.exclude(filesystem_path="/workspace").exists())

    def test_general_web_fetch_runs_shell_inside_same_workspace(self):
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as manager:
            manager.return_value.execute_tool.return_value = {"stdout": "Page text", "exit_code": 0}
            result = json.loads(execute_builtin_tool(self.user, "shell_exec", {"command": "curl -fsSL https://example.com"}, self.conversation))
            sandbox, name, arguments = manager.return_value.execute_tool.call_args.args
            self.assertEqual(sandbox.pk, self.root.pk)
            self.assertEqual(name, "shell_exec")
            self.assertIn("curl", arguments["command"])
            self.assertEqual(result["stdout"], "Page text")

    def test_retired_web_fetch_returns_error_without_network_or_starting_sandbox(self):
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as manager, patch("requests.request") as request:
            result = json.loads(execute_builtin_tool(self.user, "web_fetch", {"url": "https://example.com"}, self.conversation))
            self.assertIn("removed", result["error"])
            manager.assert_not_called()
            request.assert_not_called()
        self.assertIn("error", dispatch_file_tool("web_fetch", {"url": "https://example.com"}))

    def test_http_request_without_workspace_cannot_run(self):
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as manager:
            result = json.loads(execute_builtin_tool(self.user, "http_request", {"url": "https://api.github.com"}))
            self.assertIn("no workspace", result["error"])
            manager.assert_not_called()

    def test_sandbox_http_request_defaults_to_get_when_model_omits_method(self):
        response = Mock(status_code=200, headers={"content-type": "application/json"})
        response.json.return_value = {"ok": True}
        with patch("requests.request", return_value=response) as request:
            result = dispatch_file_tool("http_request", {"url": "https://api.github.com"})
            self.assertEqual(result["body"], {"ok": True})
            self.assertEqual(request.call_args.args[0], "GET")

    def test_guide_directs_web_fetching_to_sandbox(self):
        service = self.service()
        service.current_request = SimpleNamespace(parent=None)
        service.system_prompt = None
        service.attachments_context = ""
        service._model_catalog_guide = lambda: ""
        service._trim_messages_to_context = lambda messages: messages
        guide = service._build_messages()[0]["content"]
        self.assertNotIn("web_fetch", guide)
        self.assertIn("shell_exec with curl or Python", guide)
        self.assertIn("http_request", guide)
        self.assertIn("arbitrary HTTP/HTTPS domains", guide)
        self.assertNotIn("for allowed HTTP/API domains", guide)
        self.assertIn('default cwd and relative file root): "/workspace"', guide)

    def test_project_guide_uses_real_project_directory(self):
        project = Sandbox.objects.create(user=self.user, workspace=self.workspace, slug="app", filesystem_path="/workspace/app")
        self.root.conversations.remove(self.conversation)
        project.conversations.add(self.conversation)
        service = self.service()
        service.current_request = SimpleNamespace(parent=None)
        service.system_prompt = None
        service.attachments_context = ""
        service._model_catalog_guide = lambda: ""
        service._trim_messages_to_context = lambda messages: messages
        guide = service._build_messages()[0]["content"]
        self.assertIn('default cwd and relative file root): "/workspace/app"', guide)
        self.assertIn("does not carry over", guide)

    def test_recovery_tools_are_available_once_with_older_database(self):
        service = self.service()
        service.tools = [{"type": "function", "function": {"name": "file_rename", "parameters": {}}}]
        names = [tool["function"]["name"] for tool in service._merge_mcp_tools()]
        self.assertEqual(names.count("directory_create"), 1)
        self.assertEqual(names.count("file_rename"), 1)

    def test_legacy_workspace_defaults_do_not_override_real_project_root(self):
        Tool.objects.create(name="shell_exec", description="Shell", enabled=True, parameters_schema={"type": "object", "properties": {"command": {"type": "string"}, "cwd": {"type": "string", "default": "/workspace"}}})
        tool = next(t for t in self.service()._merge_mcp_tools() if t["function"]["name"] == "shell_exec")
        self.assertNotIn("default", tool["function"]["parameters"]["properties"]["cwd"])

    def test_old_database_and_incoming_http_descriptions_are_replaced(self):
        Tool.objects.create(name="http_request", description="Requests to a whitelisted domain", parameters_schema={}, enabled=True, is_builtin=True)
        service = self.service()
        incoming = {"type": "function", "function": {"name": "http_request", "description": "Only allowed domains"}}
        service.tools = [incoming]
        http_tools = [tool for tool in service._merge_mcp_tools() if tool["function"]["name"] == "http_request"]
        self.assertEqual(len(http_tools), 2)
        for tool in http_tools:
            self.assertEqual(tool["function"]["description"], HTTP_REQUEST_TOOL_DESCRIPTION)
        self.assertEqual(incoming["function"]["description"], "Only allowed domains")
