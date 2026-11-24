"""Built-in Playwright browser control.

The browser runs inside the conversation workspace, but it is a first-party
tool rather than a user-installed MCP connector. A single compact tool keeps
the prompt small while still exposing the core Playwright MCP operations.
"""
import logging

from django.conf import settings

from chat.tools import register

logger = logging.getLogger(__name__)

BROWSER_COMMAND = "npx -y @playwright/mcp@0.0.82"
BROWSER_TIMEOUT = 60

ACTION_TOOL = {
    "navigate": "browser_navigate",
    "back": "browser_navigate_back",
    "snapshot": "browser_snapshot",
    "find": "browser_find",
    "click": "browser_click",
    "hover": "browser_hover",
    "type": "browser_type",
    "fill_form": "browser_fill_form",
    "select_option": "browser_select_option",
    "press_key": "browser_press_key",
    "wait": "browser_wait_for",
    "screenshot": "browser_take_screenshot",
    "console": "browser_console_messages",
    "network": "browser_network_requests",
    "network_request": "browser_network_request",
    "evaluate": "browser_evaluate",
    "tabs": "browser_tabs",
    "close": "browser_close",
    "resize": "browser_resize",
    "upload": "browser_file_upload",
    "handle_dialog": "browser_handle_dialog",
    "drag": "browser_drag",
    "drop": "browser_drop",
    "emulate_media": "browser_emulate_media",
}

ACTION_FIELDS = {
    "navigate": {"url"},
    "back": set(),
    "snapshot": {"target", "filename", "depth", "boxes"},
    "find": {"text", "regex"},
    "click": {"element", "target", "doubleClick", "button", "modifiers"},
    "hover": {"element", "target"},
    "type": {"element", "target", "text", "submit", "slowly"},
    "fill_form": {"fields"},
    "select_option": {"element", "target", "values"},
    "press_key": {"key"},
    "wait": {"time", "text", "textGone"},
    "screenshot": {"element", "target", "type", "filename", "fullPage", "scale"},
    "console": {"level", "all", "filename"},
    "network": {"static", "filter", "filename"},
    "network_request": {"index", "part", "filename"},
    "evaluate": {"element", "target", "function", "filename"},
    "tabs": {"index", "url"},
    "close": set(),
    "resize": {"width", "height"},
    "upload": {"paths"},
    "handle_dialog": {"accept", "promptText"},
    "drag": {"startElement", "startTarget", "endElement", "endTarget"},
    "drop": {"element", "target", "paths", "data"},
    "emulate_media": {"colorScheme", "reducedMotion", "forcedColors", "contrast", "media"},
}

REQUIRED_FIELDS = {
    "navigate": {"url"},
    "click": {"target"},
    "hover": {"target"},
    "type": {"target", "text"},
    "fill_form": {"fields"},
    "select_option": {"target", "values"},
    "press_key": {"key"},
    "network_request": {"index"},
    "evaluate": {"function"},
    "tabs": {"tab_action"},
    "resize": {"width", "height"},
    "handle_dialog": {"accept"},
    "drag": {"startTarget", "endTarget"},
    "drop": {"target"},
}

DEFAULTS = {
    "console": {"level": "info"},
    "network": {"static": False},
    "screenshot": {"scale": "css"},
}

BROWSER_TOOL = {
    "type": "function",
    "function": {
        "name": "browser",
        "description": (
            "Control the built-in Playwright browser in the current workspace. "
            "Start with action=navigate (url), then action=snapshot to inspect the page. "
            "Interactions: click (target), hover (target), type (target, text), fill_form (fields), "
            "select_option (target, values), press_key (key), drag (startTarget, endTarget), drop (target). "
            "Other actions: find, wait, screenshot, console, network, network_request (index), evaluate (function), "
            "tabs (tab_action: list/new/close/select), back, close, resize (width, height), upload (paths), "
            "handle_dialog (accept), emulate_media. For target, prefer unique selectors like "
            "text='Search', role=button[name='Search'], button:has-text('Search'), or CSS selectors; "
            "do not reuse transient snapshot refs across turns."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": sorted(ACTION_TOOL),
                    "description": "Browser operation to perform.",
                },
                "url": {"type": "string", "description": "URL for navigate."},
                "target": {"type": "string", "description": "Unique element selector or snapshot ref."},
                "element": {"type": "string", "description": "Human-readable element description."},
                "text": {"type": "string", "description": "Text to type, wait for, or find."},
                "textGone": {"type": "string", "description": "Text to wait for to disappear."},
                "regex": {"type": "string", "description": "Regular expression for find."},
                "fields": {"type": "array", "items": {"type": "object"}, "description": "Form fields for fill_form."},
                "key": {"type": "string", "description": "Keyboard key for press_key."},
                "values": {"type": "array", "items": {"type": "string"}, "description": "Values for select_option."},
                "time": {"type": "number", "description": "Seconds to wait."},
                "filename": {"type": "string", "description": "Workspace-relative output filename."},
                "function": {"type": "string", "description": "JavaScript function for evaluate."},
                "index": {"type": "number", "description": "1-based network request index."},
                "part": {"type": "string", "description": "Network request part to return."},
                "tab_action": {
                    "type": "string",
                    "enum": ["list", "new", "close", "select"],
                    "description": "Tab operation for action=tabs.",
                },
                "width": {"type": "number", "description": "Viewport width."},
                "height": {"type": "number", "description": "Viewport height."},
                "fullPage": {"type": "boolean", "description": "Capture the full scrollable page."},
                "scale": {"type": "string", "description": "Screenshot scale: css or device."},
                "type": {"type": "string", "description": "Screenshot format: png, jpeg, or webp."},
                "depth": {"type": "number", "description": "Snapshot tree depth limit."},
                "boxes": {"type": "boolean", "description": "Include element bounding boxes in snapshots."},
                "static": {"type": "boolean", "description": "Include successful static network resources."},
                "filter": {"type": "string", "description": "Network URL regexp filter."},
                "all": {"type": "boolean", "description": "Return all console messages since the session began."},
                "level": {"type": "string", "description": "Console level: info, warning, or error."},
                "paths": {"type": "array", "items": {"type": "string"}, "description": "Absolute file paths."},
                "accept": {"type": "boolean", "description": "Accept or dismiss a dialog."},
                "promptText": {"type": "string", "description": "Prompt dialog text."},
                "doubleClick": {"type": "boolean", "description": "Double-click instead of click."},
                "button": {"type": "string", "description": "Mouse button: left, right, or middle."},
                "modifiers": {"type": "array", "items": {"type": "string"}, "description": "Modifier keys."},
                "submit": {"type": "boolean", "description": "Press Enter after typing."},
                "slowly": {"type": "boolean", "description": "Type one character at a time."},
                "startTarget": {"type": "string", "description": "Drag source selector."},
                "startElement": {"type": "string", "description": "Drag source description."},
                "endTarget": {"type": "string", "description": "Drag destination selector."},
                "endElement": {"type": "string", "description": "Drag destination description."},
                "data": {"type": "object", "description": "MIME type to data map for drop."},
                "colorScheme": {"type": "string", "description": "Emulated prefers-color-scheme."},
                "reducedMotion": {"type": "string", "description": "Emulated prefers-reduced-motion."},
                "forcedColors": {"type": "string", "description": "Emulated forced-colors mode."},
                "contrast": {"type": "string", "description": "Emulated prefers-contrast."},
                "media": {"type": "string", "description": "Emulated CSS media type."},
            },
            "required": ["action"],
        },
    },
}


def _conversation(arguments):
    conversation_id = arguments.get("_conversation_id")
    if not conversation_id:
        return None
    from chat.models import Conversation

    return Conversation.objects.select_related("workspace").filter(pk=conversation_id).first()


def _workspace(conversation):
    if conversation.workspace_id:
        return conversation.workspace
    from sandbox.services.sandbox_service import SandboxBootstrapService

    project = SandboxBootstrapService.conversation_project(conversation)
    return project.workspace if project else None


def _browser_command():
    return getattr(settings, "BUILTIN_BROWSER_COMMAND", BROWSER_COMMAND)


def _browser_timeout():
    return int(getattr(settings, "BUILTIN_BROWSER_TIMEOUT", BROWSER_TIMEOUT))


def _payload(action, arguments):
    fields = ACTION_FIELDS[action]
    payload = {name: arguments[name] for name in fields if arguments.get(name) is not None}
    if action == "tabs":
        payload["action"] = arguments.get("tab_action")
    for name, value in DEFAULTS.get(action, {}).items():
        payload.setdefault(name, value)
    return payload


def handle(user, arguments):
    if not getattr(settings, "BUILTIN_BROWSER_ENABLED", True):
        return {"error": "The built-in browser is disabled on this server."}
    action = str(arguments.get("action") or "").strip()
    if action not in ACTION_TOOL:
        return {"error": f"Unknown browser action: {action or '(missing)'}"}

    missing = [name for name in REQUIRED_FIELDS.get(action, set()) if arguments.get(name) is None]
    if missing:
        return {"error": f"browser action '{action}' requires: {', '.join(sorted(missing))}"}
    if action == "wait" and not any(arguments.get(name) is not None for name in ("time", "text", "textGone")):
        return {"error": "browser action 'wait' requires time, text, or textGone"}
    if action == "drop" and arguments.get("paths") is None and arguments.get("data") is None:
        return {"error": "browser action 'drop' requires paths or data"}

    conversation = _conversation(arguments)
    if not conversation:
        return {"error": "The built-in browser needs an active conversation workspace."}
    workspace = _workspace(conversation)
    if not workspace or not workspace.memberships.filter(user=user).exists():
        return {"error": "The conversation workspace is not available for this user."}

    from mcp.services import execute_tool

    try:
        result, duration_ms = execute_tool(
            transport="stdio",
            command=_browser_command(),
            url=None,
            env_json={},
            tool_name=ACTION_TOOL[action],
            arguments=_payload(action, arguments),
            timeout=_browser_timeout(),
            user_uuid=str(user.pk),
            workspace_uuid=str(workspace.pk),
        )
        return {"result": result, "duration_ms": duration_ms}
    except TimeoutError as error:
        return {"error": f"The browser action timed out: {error}"}
    except Exception as error:
        logger.warning("Built-in browser action %s failed: %s", action, error)
        return {"error": f"The browser action failed: {error}"}


register("browser", handle)
