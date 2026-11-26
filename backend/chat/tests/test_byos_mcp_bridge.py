"""Tests for the signed BYOS MCP bridge exposing NeuronRunner tools to Claude Code, Codex, and Gemini/Agy."""
from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from chat.models import Conversation
from chat.services.byos_mcp_bridge import (
    BYOS_MCP_SERVER_SCRIPT,
    issue_byos_mcp_token,
    verify_byos_mcp_token,
)
from chat.services.byos_runner import _normalize_byos_tool_name, _parse_byos_tool_result
from mcp.models import MCPServer, MCPServerTool
from sandbox.models import Workspace, WorkspaceMembership

User = get_user_model()


class ByosMcpBridgeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="byos-mcp-user", email="byos-mcp@example.com", password="pw")
        self.workspace = Workspace.objects.create(owner=self.user, name="MCP WS", slug="mcp-ws")
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.user, role="owner")
        self.conversation = Conversation.objects.create(user=self.user, workspace=self.workspace, title="Test")
        self.url = reverse("tool_byos_mcp_bridge")

    def test_token_roundtrip_and_tamper_rejection(self):
        token = issue_byos_mcp_token(
            user=self.user,
            conversation=self.conversation,
            workspace=self.workspace,
            cwd="/workspace/app",
        )
        claims = verify_byos_mcp_token(token)
        self.assertIsNotNone(claims)
        self.assertEqual(claims["u"], str(self.user.pk))
        self.assertEqual(claims["c"], str(self.conversation.uuid))
        self.assertEqual(claims["cwd"], "/workspace/app")
        self.assertIsNone(verify_byos_mcp_token(token + "x"))
        self.assertIsNone(verify_byos_mcp_token(""))

    def test_endpoint_rejects_unauthenticated_requests(self):
        resp = self.client.post(self.url, data=json.dumps({"action": "list"}), content_type="application/json")
        self.assertEqual(resp.status_code, 401)

    def test_list_exposes_neuronrunner_builtins_and_user_mcp_connectors(self):
        server = MCPServer.objects.create(
            user=self.user,
            name="linear",
            transport="http",
            url="https://mcp.linear.app/sse",
            enabled=True,
        )
        MCPServerTool.objects.create(
            server=server,
            name="list_issues",
            description="List Linear issues",
            input_schema={"type": "object", "properties": {}},
        )
        token = issue_byos_mcp_token(user=self.user, conversation=self.conversation, workspace=self.workspace)
        resp = self.client.post(
            self.url,
            data=json.dumps({"action": "list"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(resp.status_code, 200)
        names = {tool["name"] for tool in resp.json()["tools"]}
        for expected in ("browser", "desktop", "display_image", "image_search", "memory_add", "note_add", "session_search", "mcp__linear__list_issues"):
            self.assertIn(expected, names)

    def test_call_executes_memory_tool_and_blocks_unexposed_tools(self):
        token = issue_byos_mcp_token(user=self.user, conversation=self.conversation, workspace=self.workspace)
        resp = self.client.post(
            self.url,
            data=json.dumps({
                "action": "call",
                "name": "memory_add",
                "arguments": {"content": "Prefers concise Turkish replies"},
            }),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["result"]["status"], "ok")

        blocked = self.client.post(
            self.url,
            data=json.dumps({"action": "call", "name": "shell_exec", "arguments": {"command": "id"}}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(blocked.status_code, 200)
        self.assertIn("error", blocked.json()["result"])

    def test_tool_name_normalization_and_result_parsing_and_guest_script_syntax(self):
        self.assertEqual(_normalize_byos_tool_name("mcp__neuronrunner__browser"), "browser")
        self.assertEqual(_normalize_byos_tool_name("mcp__neuronrunner__desktop"), "desktop")
        self.assertEqual(_normalize_byos_tool_name("mcp__neuronrunner__display_image"), "display_image")
        self.assertEqual(_normalize_byos_tool_name("mcp__neuronrunner__mcp__linear__list_issues"), "mcp__linear__list_issues")
        self.assertEqual(_parse_byos_tool_result('{"status":"ok","url":"https://example.com"}'), {"status": "ok", "url": "https://example.com"})
        self.assertEqual(_parse_byos_tool_result("plain text", is_error=True), {"output": "plain text", "is_error": True})
        compile(BYOS_MCP_SERVER_SCRIPT, "byos_mcp_server.py", "exec")
