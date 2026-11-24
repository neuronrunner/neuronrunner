from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from chat.models import Conversation
from chat.services.chat_service import ChatService
from chat.tools.browser import handle
from sandbox.services.sandbox_service import SandboxBootstrapService


@override_settings(SECURE_SSL_REDIRECT=False, CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class BuiltinBrowserToolTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="browser-tool", email="browser-tool@example.com")
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.conversation = Conversation.objects.create(user=self.user, workspace=self.workspace)

    def arguments(self, **extra):
        return {"_conversation_id": str(self.conversation.uuid), **extra}

    def test_navigate_runs_the_pinned_playwright_mcp_in_the_conversation_workspace(self):
        with patch("mcp.services.execute_tool", return_value=("ok", 12)) as execute:
            result = handle(self.user, self.arguments(action="navigate", url="http://localhost:3000"))
        self.assertEqual(result, {"result": "ok", "duration_ms": 12})
        self.assertEqual(execute.call_args.kwargs["transport"], "stdio")
        self.assertEqual(execute.call_args.kwargs["command"], "npx -y @playwright/mcp@0.0.82")
        self.assertEqual(execute.call_args.kwargs["tool_name"], "browser_navigate")
        self.assertEqual(execute.call_args.kwargs["arguments"], {"url": "http://localhost:3000"})
        self.assertEqual(execute.call_args.kwargs["user_uuid"], str(self.user.pk))
        self.assertEqual(execute.call_args.kwargs["workspace_uuid"], str(self.workspace.pk))
        self.assertEqual(execute.call_args.kwargs["timeout"], 60)

    def test_snapshot_tabs_and_defaults_build_mcp_payloads(self):
        with patch("mcp.services.execute_tool", return_value=("ok", 1)) as execute:
            handle(self.user, self.arguments(action="snapshot", target="main", filename="page.txt"))
            self.assertEqual(execute.call_args.kwargs["tool_name"], "browser_snapshot")
            self.assertEqual(execute.call_args.kwargs["arguments"], {"target": "main", "filename": "page.txt"})

            handle(self.user, self.arguments(action="tabs", tab_action="new", url="https://example.com"))
            self.assertEqual(execute.call_args.kwargs["tool_name"], "browser_tabs")
            self.assertEqual(execute.call_args.kwargs["arguments"], {"url": "https://example.com", "action": "new"})

            handle(self.user, self.arguments(action="console"))
            self.assertEqual(execute.call_args.kwargs["arguments"], {"level": "info"})

            handle(self.user, self.arguments(action="network"))
            self.assertEqual(execute.call_args.kwargs["arguments"], {"static": False})

            handle(self.user, self.arguments(action="screenshot"))
            self.assertEqual(execute.call_args.kwargs["arguments"], {"scale": "css"})

    def test_invalid_actions_and_missing_required_fields_are_rejected_before_execution(self):
        with patch("mcp.services.execute_tool") as execute:
            self.assertIn("error", handle(self.user, self.arguments(action="unknown")))
            self.assertIn("requires", handle(self.user, self.arguments(action="click"))["error"])
            self.assertIn("requires", handle(self.user, self.arguments(action="wait"))["error"])
            self.assertIn("requires", handle(self.user, self.arguments(action="drop"))["error"])
            execute.assert_not_called()

    def test_workspace_membership_and_conversation_are_required(self):
        with patch("mcp.services.execute_tool") as execute:
            self.assertIn("error", handle(self.user, {"action": "navigate", "url": "https://example.com"}))
            self.workspace.memberships.filter(user=self.user).delete()
            self.assertIn("error", handle(self.user, self.arguments(action="navigate", url="https://example.com")))
            execute.assert_not_called()

    def test_disabled_browser_returns_an_actionable_error(self):
        with override_settings(BUILTIN_BROWSER_ENABLED=False), patch("mcp.services.execute_tool") as execute:
            self.assertIn("disabled", handle(self.user, self.arguments(action="navigate", url="https://example.com"))["error"])
            execute.assert_not_called()

    def test_browser_tool_is_available_without_an_mcp_connector(self):
        service = ChatService.__new__(ChatService)
        service.conversation = self.conversation
        service.tools = None
        service._get_mcp_tools = lambda: []
        names = [tool["function"]["name"] for tool in service._merge_mcp_tools()]
        self.assertEqual(names.count("browser"), 1)
        with override_settings(BUILTIN_BROWSER_ENABLED=False):
            names = [tool["function"]["name"] for tool in service._merge_mcp_tools()]
        self.assertNotIn("browser", names)

    def test_browser_tool_is_hidden_without_a_workspace(self):
        conversation = Conversation.objects.create(user=self.user)
        service = ChatService.__new__(ChatService)
        service.conversation = conversation
        service.tools = None
        service._get_mcp_tools = lambda: []
        self.assertNotIn("browser", [tool["function"]["name"] for tool in service._merge_mcp_tools()])
