"""Signed internal MCP bridge exposing NeuronRunner's built-in tools and workspace MCP connectors to BYOS CLIs.

When Claude Code, Codex, Antigravity, or Gemini CLI runs inside a workspace VM, it launches
``/var/lib/neuronrunner/byos_mcp_server.py`` as a stdio MCP server with a short-lived,
HMAC-signed bearer token scoped to the active (user, conversation, workspace, sandbox).
The stdio server forwards ``tools/list`` and ``tools/call`` to ``POST /tools/byos-mcp/``.
"""
from __future__ import annotations

import base64
import json
import logging
from typing import Any

from django.conf import settings
from django.core import signing

logger = logging.getLogger(__name__)

TOKEN_SALT = "neuronrunner-byos-mcp-v1"
TOKEN_MAX_AGE_SECONDS = 2400

# NeuronRunner-native tools that BYOS CLIs do not have built in.
BYOS_BRIDGE_BUILTIN_NAMES: tuple[str, ...] = (
    "browser",
    "desktop",
    "display_image",
    "image_search",
    "memory_add",
    "memory_replace",
    "memory_remove",
    "memory_list",
    "memory_search",
    "note_add",
    "note_replace",
    "note_remove",
    "note_list",
    "note_search",
    "session_search",
    "issue_list",
    "issue_get",
    "issue_create",
    "issue_comment",
    "issue_update",
)

BYOS_BRIDGE_BUILTIN_SET = frozenset(BYOS_BRIDGE_BUILTIN_NAMES)


def resolve_byos_mcp_bridge_url() -> str:
    """Return the backend URL reachable from inside the workspace VM, or empty string if unavailable."""
    base = (getattr(settings, "MCP_OAUTH_PUBLIC_BASE_URL", "") or "").strip().rstrip("/")
    if base:
        return f"{base}/tools/byos-mcp/"
    # Self-hosted local Docker fallback
    if (getattr(settings, "SANDBOX_PROVIDER", "docker") or "docker").strip().lower() == "docker":
        port = getattr(settings, "PORT", 8000) or 8000
        return f"http://host.docker.internal:{port}/tools/byos-mcp/"
    return ""


def issue_byos_mcp_token(*, user, conversation, project=None, workspace=None, cwd: str = "/workspace") -> str:
    payload = {
        "u": str(user.pk),
        "c": str(conversation.uuid),
        "s": str(project.uuid) if project is not None else "",
        "w": str(workspace.uuid) if workspace is not None else "",
        "cwd": str(cwd or "/workspace"),
    }
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
    return signing.TimestampSigner(salt=TOKEN_SALT).sign(raw)


def verify_byos_mcp_token(token: str) -> dict[str, Any] | None:
    if not token or not isinstance(token, str):
        return None
    try:
        raw = signing.TimestampSigner(salt=TOKEN_SALT).unsign(token.strip(), max_age=TOKEN_MAX_AGE_SECONDS)
        data = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")).decode("utf-8"))
        if not isinstance(data, dict) or not data.get("u") or not data.get("c"):
            return None
        return data
    except Exception:
        return None


def _builtin_schema_map() -> dict[str, dict]:
    from chat.builtin_tools import BUILTIN_TOOLS
    from chat.tools.browser import BROWSER_TOOL
    from chat.tools.display_image import DISPLAY_IMAGE_TOOL
    from chat.tools.image_search import IMAGE_SEARCH_TOOL
    from chat.tools.issues import ISSUE_TOOLS

    schemas: dict[str, dict] = {}
    for entry in (*BUILTIN_TOOLS, BROWSER_TOOL, DISPLAY_IMAGE_TOOL, IMAGE_SEARCH_TOOL, *ISSUE_TOOLS):
        fn = entry.get("function") if isinstance(entry, dict) else None
        if not isinstance(fn, dict):
            continue
        name = fn.get("name")
        if name in BYOS_BRIDGE_BUILTIN_SET:
            schemas[name] = {
                "name": name,
                "description": fn.get("description") or f"NeuronRunner {name} tool",
                "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
            }
    return schemas


def list_byos_mcp_tools(user, conversation) -> list[dict]:
    """Return MCP-formatted tool descriptors for NeuronRunner built-ins + user's enabled MCP connectors."""
    schemas = _builtin_schema_map()
    browser_enabled = bool(getattr(settings, "BUILTIN_BROWSER_ENABLED", True))
    tools: list[dict] = []
    for name in BYOS_BRIDGE_BUILTIN_NAMES:
        if name == "browser" and not browser_enabled:
            continue
        spec = schemas.get(name)
        if spec:
            tools.append(spec)

    # Also expose all enabled workspace/user MCP connectors (Slack, GitHub, Notion, Linear, Postgres, etc.)
    try:
        from mcp.models import MCPServer

        servers = MCPServer.objects.filter(user=user, enabled=True).prefetch_related("tools")
        for server in servers:
            for tool in server.tools.all():
                full_name = f"mcp__{server.name}__{tool.name}"
                schema = tool.input_schema if isinstance(tool.input_schema, dict) else {"type": "object", "properties": {}}
                tools.append({
                    "name": full_name,
                    "description": tool.description or f"Tool {tool.name} from {server.name}",
                    "inputSchema": schema,
                })
    except Exception:
        logger.debug("Could not load user MCP servers for BYOS bridge", exc_info=True)

    return tools


def execute_byos_mcp_tool(user, conversation, tool_name: str, arguments: dict | None = None) -> dict:
    """Execute a bridged NeuronRunner built-in tool or workspace MCP connector tool."""
    args = dict(arguments) if isinstance(arguments, dict) else {}
    if tool_name.startswith("mcp__"):
        from chat.services.chat_service import ChatService

        service = ChatService(conversation=conversation)
        return service.execute_mcp_tool(tool_name, args)

    if tool_name not in BYOS_BRIDGE_BUILTIN_SET:
        return {"error": f"Tool '{tool_name}' is not exposed by the NeuronRunner BYOS MCP bridge."}

    from chat.builtin_tools import execute_builtin_tool

    raw = execute_builtin_tool(user, tool_name, args, conversation=conversation)
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"output": parsed}
    except (ValueError, TypeError):
        return {"output": str(raw)}


# Pure stdlib stdio MCP server written into /var/lib/neuronrunner/byos_mcp_server.py inside the VM.
BYOS_MCP_SERVER_SCRIPT = r'''#!/usr/bin/env python3
"""Stdio MCP server bridging NeuronRunner built-in tools and workspace MCP connectors to BYOS CLIs."""
import json
import os
import sys
import urllib.error
import urllib.request

BRIDGE_URL = (os.environ.get("NR_MCP_BRIDGE_URL") or "").strip()
BRIDGE_TOKEN = (os.environ.get("NR_MCP_BRIDGE_TOKEN") or "").strip()
PROTOCOL_VERSION = "2024-11-05"


def _bridge_call(payload):
    if not BRIDGE_URL or not BRIDGE_TOKEN:
        return {"error": "NeuronRunner MCP bridge is not configured."}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BRIDGE_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "User-Agent": "NeuronRunner-BYOS-MCP/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:
            detail = str(exc)
        return {"error": f"Bridge HTTP {exc.code}: {detail[:500]}"}
    except Exception as exc:
        return {"error": f"Bridge request failed: {exc}"}


def _write_message(msg, framed=False):
    raw = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    if framed:
        header = f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii")
        sys.stdout.buffer.write(header + raw)
    else:
        sys.stdout.buffer.write(raw + b"\n")
    sys.stdout.buffer.flush()


def _read_message():
    line = sys.stdin.buffer.readline()
    if not line:
        return None, False
    stripped = line.strip()
    if not stripped:
        return {}, False
    if stripped.lower().startswith(b"content-length:"):
        length = int(stripped.split(b":", 1)[1].strip())
        while True:
            hdr = sys.stdin.buffer.readline()
            if not hdr or hdr in (b"\r\n", b"\n"):
                break
        body = sys.stdin.buffer.read(length)
        return json.loads(body.decode("utf-8")), True
    return json.loads(stripped.decode("utf-8")), False


def _handle(msg):
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        client_ver = params.get("protocolVersion") or PROTOCOL_VERSION
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": client_ver,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "neuronrunner", "version": "1.0.0"},
            },
        }
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "tools/list":
        data = _bridge_call({"action": "list"})
        tools = data.get("tools") if isinstance(data, dict) else []
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": tools or []}}
    if method == "tools/call":
        name = str(params.get("name") or "").strip()
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        data = _bridge_call({"action": "call", "name": name, "arguments": arguments})
        result = data.get("result") if isinstance(data, dict) and "result" in data else data
        is_error = bool(isinstance(result, dict) and result.get("error"))
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": is_error,
            },
        }
    if msg_id is None:
        return None
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    while True:
        try:
            msg, framed = _read_message()
        except Exception:
            continue
        if msg is None:
            break
        if not msg:
            continue
        reply = _handle(msg)
        if reply is not None:
            _write_message(reply, framed=framed)


if __name__ == "__main__":
    main()
'''
