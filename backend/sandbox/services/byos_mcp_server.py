"""Lightweight stdio MCP server exposing NeuronRunner's desktop tool inside the workspace VM."""
from __future__ import annotations

import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "neuronrunner-desktop", "version": "1.0.0"}

DESKTOP_TOOL_SCHEMA: dict[str, Any] = {
    "name": "desktop",
    "description": (
        "Control the live KDE Linux desktop (DISPLAY :1, with virtual audio sink nr_speaker). "
        "Starts the desktop automatically if not running. "
        "Supports screenshot, click, double_click, right_click, move_mouse, drag, scroll, press, write, "
        "launch, wait, screen_size, start_recording (captures video + audio to MP4), and stop_recording. "
        "By default, visual actions automatically capture an updated screenshot and attach it to your visual context."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "screenshot",
                    "click",
                    "double_click",
                    "right_click",
                    "move_mouse",
                    "drag",
                    "scroll",
                    "press",
                    "write",
                    "launch",
                    "wait",
                    "screen_size",
                    "start_recording",
                    "stop_recording",
                ],
                "description": "Desktop action to perform.",
            },
            "x": {"type": "integer", "description": "Horizontal pixel coordinate on the guest display."},
            "y": {"type": "integer", "description": "Vertical pixel coordinate on the guest display."},
            "to_x": {"type": "integer", "description": "Destination X coordinate for drag."},
            "to_y": {"type": "integer", "description": "Destination Y coordinate for drag."},
            "button": {"type": "string", "enum": ["left", "middle", "right"], "default": "left"},
            "count": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1, "description": "Click count (1-3)."},
            "direction": {"type": "string", "enum": ["up", "down", "left", "right"], "default": "down"},
            "amount": {"type": "integer", "minimum": 1, "maximum": 100, "default": 3, "description": "Scroll step count (1-100)."},
            "key": {"type": "string", "description": "X11 key name or combo for press (e.g. 'Return', 'ctrl+l', 'alt+Tab', 'BackSpace', 'Escape')."},
            "keys": {"type": "array", "items": {"type": "string"}, "description": "Sequence of X11 key names to press in order."},
            "text": {"type": "string", "description": "Literal UTF-8 text to paste/type into the focused field (for action='write')."},
            "press_enter": {"type": "boolean", "default": False, "description": "Whether to press Return after writing text."},
            "command": {"type": "string", "description": "GUI application command to launch on DISPLAY :1 (e.g. 'chromium https://example.com' or 'konsole')."},
            "path": {"type": "string", "description": "Optional workspace file path to save a screenshot (.png) or screen recording (.mp4)."},
            "fps": {"type": "integer", "minimum": 1, "maximum": 60, "default": 30, "description": "Frame rate for start_recording (1-60)."},
            "wait_ms": {"type": "integer", "minimum": 50, "maximum": 15000, "description": "Milliseconds to wait after the action before capturing the screenshot (or duration for action='wait')."},
            "include_screenshot": {"type": "boolean", "default": True, "description": "Automatically capture and attach a screenshot after the action."},
        },
        "required": ["action"],
    },
}

_FILE_TOOLS_MOD = None


def _load_file_tools():
    global _FILE_TOOLS_MOD
    if _FILE_TOOLS_MOD is not None:
        return _FILE_TOOLS_MOD

    candidates = [
        Path("/var/lib/neuronrunner/file_tools.py"),
        Path(__file__).resolve().with_name("file_tools.py"),
    ]
    for path in candidates:
        if path.is_file():
            spec = importlib.util.spec_from_file_location("nr_byos_file_tools", str(path))
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                _FILE_TOOLS_MOD = mod
                return mod
    raise RuntimeError("NeuronRunner file_tools.py not found in VM")


def _parse_data_url(data_url: str) -> tuple[str, str] | None:
    if not isinstance(data_url, str) or not data_url.startswith("data:") or ";base64," not in data_url:
        return None
    header, b64_data = data_url.split(";base64,", 1)
    mime_type = header[5:] or "image/png"
    if not b64_data:
        return None
    return mime_type, b64_data


def format_desktop_tool_result(result: Any) -> dict[str, Any]:
    """Convert desktop_control output into an MCP tools/call result with optional image block."""
    if not isinstance(result, dict):
        return {"content": [{"type": "text", "text": json.dumps({"result": result}, ensure_ascii=False)}], "isError": False}

    is_error = bool(result.get("error"))
    image_info = _parse_data_url(result.get("image_url") or "")
    meta = {k: v for k, v in result.items() if k != "image_url"}

    content: list[dict[str, Any]] = [
        {"type": "text", "text": json.dumps(meta, ensure_ascii=False)}
    ]
    if image_info is not None:
        mime_type, b64_data = image_info
        content.append({"type": "image", "data": b64_data, "mimeType": mime_type})

    return {"content": content, "isError": is_error}


def _call_desktop(arguments: dict[str, Any]) -> dict[str, Any]:
    file_tools = _load_file_tools()
    if not os.environ.get("WORKSPACE_ROOT"):
        os.environ["WORKSPACE_ROOT"] = os.getcwd() or "/workspace"
    with contextlib.redirect_stdout(sys.stderr):
        result = file_tools.desktop_control(**(arguments or {}))
    return format_desktop_tool_result(result)


def handle_jsonrpc_message(message: dict[str, Any]) -> dict[str, Any] | None:
    """Process one JSON-RPC 2.0 request/notification and return a response dict or None."""
    method = message.get("method")
    req_id = message.get("id")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    # Notifications (no id) do not receive a JSON-RPC response.
    if req_id is None:
        return None

    if method == "initialize":
        client_version = params.get("protocolVersion") or PROTOCOL_VERSION
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": client_version,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        }

    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": [DESKTOP_TOOL_SCHEMA]},
        }

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        if tool_name != "desktop":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps({"error": f"Unknown tool: {tool_name}"})}],
                    "isError": True,
                },
            }
        try:
            tool_result = _call_desktop(arguments)
        except Exception as exc:
            tool_result = {
                "content": [{"type": "text", "text": json.dumps({"error": str(exc)})}],
                "isError": True,
            }
        return {"jsonrpc": "2.0", "id": req_id, "result": tool_result}

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> None:
    out = sys.stdout
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            out.write(json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "Parse error"},
            }) + "\n")
            out.flush()
            continue
        if not isinstance(msg, dict):
            continue
        response = handle_jsonrpc_message(msg)
        if response is not None:
            out.write(json.dumps(response, ensure_ascii=False) + "\n")
            out.flush()


if __name__ == "__main__":
    main()
