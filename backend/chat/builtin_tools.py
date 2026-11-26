"""
Built-in tool handlers & executor for NeuronRunner.

Each handler is a standalone function(user, arguments) -> dict registered with the
ToolRegistry. The top-level `execute_builtin_tool()` delegates to the registry.

Legacy BUILTIN_TOOLS list kept for backward compat in chat_service._merge_mcp_tools();
new code should load Tool model definitions from DB instead.
"""
import json
import logging

from django.db.models import Q

from chat.constants import HTTP_REQUEST_TOOL_DESCRIPTION
from chat.tools import execute as registry_execute
from chat.tools import register
from chat.tools.display_image import handle_display_image
from chat.tools.view_image import handle_view_image, VIEW_IMAGE_TOOL
from chat.tools.web_search import WEB_SEARCH_TOOL
from chat.tools.image_search import IMAGE_SEARCH_TOOL

logger = logging.getLogger(__name__)


def _store_operation(user, arguments, kind, action):
    from chat.models import Conversation
    from chat.services.memory_service import MemoryService, NoteService, StoreError, serialize
    try:
        conversation = None
        if arguments.get("_conversation_id"):
            conversation = Conversation.objects.get(pk=arguments["_conversation_id"])
        cls = MemoryService if kind == "memory" else NoteService
        service = cls(user, conversation=conversation,
                      sandbox_uuid=arguments.get("sandbox_uuid"),
                      workspace_uuid=arguments.get("workspace_uuid"))
        if action == "add":
            record, created = service.create(arguments)
            return {"status": "ok", **serialize(record), "created": created}
        if action == "replace":
            data = dict(arguments)
            data["content"] = data.pop("new_content", None)
            return {"status": "ok", **serialize(service.update(data))}
        if action == "remove":
            return {"status": "ok", "removed_uuid": service.remove(arguments)}
        records = service.search(arguments) if action == "search" else service.list(arguments)
        data = [serialize(record) for record in records]
        return {"count": len(data), "memories" if kind == "memory" else "notes": data}
    except StoreError as exc:
        return exc.as_dict()


def handle_memory_add(user, arguments):
    return _store_operation(user, arguments, "memory", "add")


def handle_memory_replace(user, arguments):
    return _store_operation(user, arguments, "memory", "replace")


def handle_memory_remove(user, arguments):
    return _store_operation(user, arguments, "memory", "remove")


def handle_memory_list(user, arguments):
    return _store_operation(user, arguments, "memory", "list")


def handle_memory_search(user, arguments):
    return _store_operation(user, arguments, "memory", "search")


def handle_note_add(user, arguments):
    return _store_operation(user, arguments, "note", "add")


def handle_note_replace(user, arguments):
    return _store_operation(user, arguments, "note", "replace")


def handle_note_remove(user, arguments):
    return _store_operation(user, arguments, "note", "remove")


def handle_note_list(user, arguments):
    return _store_operation(user, arguments, "note", "list")


def handle_note_search(user, arguments):
    return _store_operation(user, arguments, "note", "search")


def handle_session_search(user, arguments: dict) -> dict:
    from chat.models import Message
    from chat.services.search_text import candidate_patterns, matched_terms, search_terms
    query = (arguments.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    limit = min(10, max(1, int(arguments.get("limit", 3))))

    terms = search_terms(query)
    lexical_q = Q(content__icontains=query)
    for pattern in candidate_patterns(terms):
        lexical_q |= Q(content__iregex=pattern)

    candidates = (
        Message.objects.filter(conversation__user=user)
        .filter(lexical_q)
        .select_related("conversation")
        .order_by("-created_at")[:limit * 10]
    )

    matches = []
    for m in candidates:
        if query.lower() in (m.content or "").lower() or (terms and matched_terms(m.content, terms) > 0):
            matches.append(m)

    seen_convs = set()
    sessions_data = []
    for m in matches:
        conv = m.conversation
        if conv.uuid in seen_convs:
            continue
        if len(seen_convs) >= limit:
            break
        seen_convs.add(conv.uuid)

        window_messages = list(
            Message.objects.filter(conversation=conv)
            .order_by('created_at')
            .values('content', 'role', 'created_at')
        )
        match_idx = None
        for i, wm in enumerate(window_messages):
            if query.lower() in wm['content'].lower() or (terms and matched_terms(wm['content'], terms) > 0):
                match_idx = i
                break
        if match_idx is not None:
            start = max(0, match_idx - 2)
            end = min(len(window_messages), match_idx + 3)
            snippet_messages = window_messages[start:end]
        else:
            snippet_messages = window_messages[:3]

        sessions_data.append({
            "session_id": str(conv.uuid),
            "title": conv.title or "Untitled",
            "created_at": conv.created_at.isoformat() if conv.created_at else None,
            "snippet": " | ".join(
                f"{sm['role']}: {sm['content'][:150]}"
                for sm in snippet_messages
            ),
            "match_count": 1,
        })

    return {"count": len(sessions_data), "sessions": sessions_data}


# ─── File Tools (Codex-style, run in user's project sandbox) ──────────────────

def _ensure_file_tool_args(tool_name: str, user, arguments: dict) -> dict:
    """Sanity-check tool arguments, auto-start the selected VM if needed, and resolve the active project."""
    if not isinstance(arguments, dict):
        return {"error": f"{tool_name}: arguments must be an object"}

    args_copy = dict(arguments)
    # Internal context comes from the conversation, never from model arguments.
    sandbox_uuid = args_copy.pop("_sandbox_uuid", None)
    vm_uuid = args_copy.pop("_vm_uuid", None) or args_copy.pop("vm_uuid", None)
    runtime_name = args_copy.pop("_runtime", "") or ""
    workspace_root = args_copy.pop("_workspace_root", None) or None
    args_copy.pop("sandbox_uuid", None)
    args_copy.pop("workspace_uuid", None)
    args_copy.pop("_conversation_id", None)
    if not sandbox_uuid:
        return {"error": f"{tool_name}: this conversation has no workspace attached"}

    from sandbox.models import Sandbox
    sandbox = (
        Sandbox.objects.filter(uuid=sandbox_uuid)
        .filter(Q(user=user) | Q(workspace__memberships__user=user))
        .distinct().first()
    )
    if not sandbox:
        return {"error": f"{tool_name}: conversation workspace is unavailable"}

    return {"sandbox": sandbox, "args": args_copy, "runtime": runtime_name, "workspace_root": workspace_root}


def _execute_in_sandbox(tool_name: str, user, arguments: dict) -> dict:
    """Resolve the sandbox and execute the tool inside the workspace container."""
    resolved = _ensure_file_tool_args(tool_name, user, arguments)
    if "error" in resolved:
        return resolved
    project = resolved["sandbox"]
    args = resolved["args"]
    # Filter out metadata arguments prefixed with underscores
    clean_args = {k: v for k, v in args.items() if not k.startswith("_")}
    from sandbox.services.sandbox_session import get_sandbox_manager
    runtime_kwargs = {"runtime": resolved["runtime"]} if resolved.get("runtime") else {}
    if resolved.get("workspace_root"):
        runtime_kwargs["workspace_root"] = resolved["workspace_root"]
    return get_sandbox_manager().execute_tool(project, tool_name, clean_args, **runtime_kwargs)


def handle_file_read(user, arguments: dict) -> dict:
    return _execute_in_sandbox("file_read", user, arguments)


def handle_file_write(user, arguments: dict) -> dict:
    args = arguments or {}
    if args.get("content") is None:
        return {"error": "file_write: content required"}
    return _execute_in_sandbox("file_write", user, arguments)


def handle_file_patch(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("find") or args.get("replace") is None:
        return {"error": "file_patch: find and replace required"}
    return _execute_in_sandbox("file_patch", user, arguments)


def handle_file_content_search(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("pattern"):
        return {"error": "file_content_search: pattern required"}
    return _execute_in_sandbox("file_content_search", user, arguments)


def handle_shell_exec(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("command"):
        return {"error": "shell_exec: command required"}
    return _execute_in_sandbox("shell_exec", user, arguments)


def handle_list_directory(user, arguments: dict) -> dict:
    return _execute_in_sandbox("list_directory", user, arguments)


def handle_glob_files(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("pattern"):
        return {"error": "glob_files: pattern required"}
    return _execute_in_sandbox("glob_files", user, arguments)


def handle_file_delete(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("path"):
        return {"error": "file_delete: path required"}
    return _execute_in_sandbox("file_delete", user, arguments)


def handle_file_rename(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("old_path") or not args.get("new_path"):
        return {"error": "file_rename: old_path and new_path required"}
    return _execute_in_sandbox("file_rename", user, arguments)


def handle_directory_create(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("path"):
        return {"error": "directory_create: path required"}
    return _execute_in_sandbox("directory_create", user, arguments)


def handle_http_request(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("url"):
        return {"error": "http_request: url required"}
    return _execute_in_sandbox("http_request", user, arguments)


def handle_desktop(user, arguments: dict) -> dict:
    args = arguments or {}
    if not args.get("action"):
        return {"error": "desktop: action required"}
    return _execute_in_sandbox("desktop", user, arguments)


# ─── Registration ─────────────────────────────────────────────────────────────

def register_all_handlers():
    """Register all built-in handlers with the ToolRegistry."""
    register("memory_add", handle_memory_add)
    register("memory_replace", handle_memory_replace)
    register("memory_remove", handle_memory_remove)
    register("memory_list", handle_memory_list)
    register("memory_search", handle_memory_search)
    register("note_add", handle_note_add)
    register("note_replace", handle_note_replace)
    register("note_remove", handle_note_remove)
    register("note_list", handle_note_list)
    register("note_search", handle_note_search)
    register("session_search", handle_session_search)
    register("file_read", handle_file_read)
    register("file_write", handle_file_write)
    register("file_patch", handle_file_patch)
    register("file_content_search", handle_file_content_search)
    register("shell_exec", handle_shell_exec)
    register("list_directory", handle_list_directory)
    register("glob_files", handle_glob_files)
    register("http_request", handle_http_request)
    register("file_delete", handle_file_delete)
    register("file_rename", handle_file_rename)
    register("directory_create", handle_directory_create)
    register("desktop", handle_desktop)
    register("display_image", handle_display_image)
    register("view_image", handle_view_image)

register_all_handlers()


# ─── Legacy executor (delegates to ToolRegistry) ─────────────────────────────

def execute_builtin_tool_stream(user, tool_name: str, arguments: dict, conversation=None, stream_output=True):
    """Execute a tool and yield intermediate progress events, returning the final JSON string result at the end."""
    try:
        arguments = dict(arguments)
        arguments.pop("_sandbox_uuid", None)
        arguments.pop("_conversation_id", None)
        arguments.pop("_workspace_uuid", None)
        arguments.pop("_runtime", None)
        arguments.pop("_workspace_root", None)
        if tool_name == "title_generation":
            yield "result", json.dumps({"error": "Conversation titles are generated automatically in the background."})
            return
        if tool_name == "web_fetch":
            yield "result", json.dumps({"error": "web_fetch was removed. Use http_request or shell_exec in the conversation workspace sandbox."})
            return
        if tool_name in {"sandbox_create", "sandbox_list", "sandbox_use"}:
            yield "result", json.dumps({"error": "Tools use the conversation workspace automatically."})
            return
        if conversation and tool_name not in {"web_search", "image_search"}:
            from sandbox.services.sandbox_service import SandboxBootstrapService
            arguments.pop("sandbox_uuid", None)
            arguments.pop("workspace_uuid", None)
            arguments["_conversation_id"] = str(conversation.uuid)
            arguments["_runtime"] = getattr(conversation, "runtime_name", "") or ""
            sandbox = SandboxBootstrapService.conversation_project(conversation)
            if sandbox:
                arguments["_sandbox_uuid"] = str(sandbox.uuid)
                if getattr(sandbox, "vm_id", None):
                    arguments["_vm_uuid"] = str(sandbox.vm_id)
                # A chat that picked its own branch works in a private worktree, never the shared project folder.
                from sandbox.services.conversation_worktree import active_worktree_path
                worktree = active_worktree_path(conversation, sandbox)
                if worktree:
                    arguments["_workspace_root"] = worktree

        if tool_name == "shell_exec" and stream_output:
            resolved = _ensure_file_tool_args(tool_name, user, arguments)
            if "error" in resolved:
                yield "result", json.dumps(resolved)
                return
            from queue import Queue, Empty
            from threading import Thread
            from django.db import close_old_connections
            from sandbox.services.sandbox_session import get_sandbox_manager
            events = Queue()
            manager = get_sandbox_manager()
            clean_args = {key: value for key, value in resolved["args"].items() if not key.startswith("_")}
            def run_shell():
                close_old_connections()
                try:
                    runtime_kwargs = {"runtime": resolved["runtime"]} if resolved.get("runtime") else {}
                    if resolved.get("workspace_root"):
                        runtime_kwargs["workspace_root"] = resolved["workspace_root"]
                    result = manager.execute_tool(resolved["sandbox"], "shell_exec", clean_args, **runtime_kwargs,
                        on_output=lambda stream, text: events.put(("output", json.dumps({"stream": stream, "text": text}))))
                    events.put(("result", json.dumps(result)))
                except Exception as error:
                    events.put(("result", json.dumps({"error": str(error)})))
                finally:
                    close_old_connections()
            Thread(target=run_shell, daemon=True).start()
            while True:
                try:
                    event = events.get(timeout=0.5)
                except Empty:
                    yield "heartbeat", ""
                    continue
                yield event
                if event[0] == "result":
                    return
        result = registry_execute(tool_name, user, arguments)
        yield "result", json.dumps(result)
    except Exception as e:
        logger.exception("Tool %s failed: %s", tool_name, e)
        yield "result", json.dumps({"error": str(e)})


def execute_builtin_tool(user, tool_name: str, arguments: dict, conversation=None) -> str:
    """Execute a tool synchronously and return the JSON string result."""
    stream = execute_builtin_tool_stream(user, tool_name, arguments, conversation=conversation, stream_output=False)
    result = None
    for ev_type, chunk in stream:
        if ev_type == "result":
            result = chunk
    return result


# ─── Legacy tool definitions (OpenAI function schemas, for backward compat) ──

BUILTIN_TOOLS = [
    IMAGE_SEARCH_TOOL,
    VIEW_IMAGE_TOOL,
    WEB_SEARCH_TOOL,

    {
        "type": "function",
        "function": {
            "name": "memory_add",
            "description": "Save a fact about the user (identity, preference, project, etc.). Use this to remember user-provided information across conversations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "The fact to remember. Write as a clear standalone sentence."},
                    "category": {"type": "string", "enum": ["identity", "preference", "workspace", "knowledge", "relationship"], "description": "Category of the memory."},
                    "label": {"type": "string", "description": "Optional short label for quick reference (e.g. 'name', 'framework', 'location')."},
                    "importance_score": {"type": "integer", "description": "Importance 1-10, used with relevance and recency when ranking.", "minimum": 1, "maximum": 10},
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_replace",
            "description": "Update an existing user memory. Finds by old_text substring match (Hermes style).",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_text": {"type": "string", "description": "Text to find in existing memory (case-insensitive substring match)."},
                    "new_content": {"type": "string", "description": "New content for the memory."},
                    "category": {"type": "string", "enum": ["identity", "preference", "workspace", "knowledge", "relationship"], "description": "New category (optional)."},
                    "importance_score": {"type": "integer", "description": "New importance 1-10 (optional).", "minimum": 1, "maximum": 10},
                },
                "required": ["old_text", "new_content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_remove",
            "description": "Delete a user memory by old_text substring match.",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_text": {"type": "string", "description": "Text to find in existing memory (case-insensitive substring match)."},
                },
                "required": ["old_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_list",
            "description": "List all saved user memories. Optional filter by category or label.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["identity", "preference", "workspace", "knowledge", "relationship"], "description": "Filter by category."},
                    "label": {"type": "string", "description": "Filter by label."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_search",
            "description": "Search user memories by meaning. Use when you need to recall information about the user (identity, preferences, projects, etc.). Works with natural language queries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language query describing what you're looking for (e.g. 'user's tech stack preferences')"},
                    "limit": {"type": "integer", "description": "Max results to return (default 5, max 20)", "minimum": 1, "maximum": 20, "default": 5},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_add",
            "description": "Save a general note about the user's environment, project, tools, or preferences. Use this for context that is NOT about the user personally but about their setup.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "The note content. Be specific and self-contained."},
                    "category": {"type": "string", "description": "Optional category like 'project', 'tool', 'env', 'preference'."},
                    "importance_score": {"type": "integer", "description": "Importance 1-10.", "minimum": 1, "maximum": 10},
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_replace",
            "description": "Update an existing note by old_text substring match.",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_text": {"type": "string", "description": "Text to find in existing note."},
                    "new_content": {"type": "string", "description": "New content for the note."},
                    "importance_score": {"type": "integer", "description": "New importance 1-10.", "minimum": 1, "maximum": 10},
                },
                "required": ["old_text", "new_content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_remove",
            "description": "Delete a note by old_text substring match.",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_text": {"type": "string", "description": "Text to find in existing note."},
                },
                "required": ["old_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_list",
            "description": "List all saved notes. Optional filter by category.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "Filter by category."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_search",
            "description": "Search agent notes by meaning. Use to find context about environment, tools, setup, or conventions. Works with natural language queries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language query describing what you're looking for (e.g. 'project setup and dependencies')"},
                    "limit": {"type": "integer", "description": "Max results to return (default 5, max 20)", "minimum": 1, "maximum": 20, "default": 5},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_search",
            "description": "Search past conversations by keyword. Use when the user references something discussed before. Returns matching conversation snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Keywords to search for in past conversations (e.g. 'deployment error 502')"},
                    "limit": {"type": "integer", "description": "Max conversations to return (default 3, max 10)", "minimum": 1, "maximum": 10, "default": 3},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_read",
            "description": "Read a file from the user's project sandbox. Returns the file's content up to a byte limit. Use offset/limit to page large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Sandbox-relative path, e.g. 'src/main.py'."},
                    "offset": {"type": "integer", "default": 0, "description": "Byte offset."},
                    "limit": {"type": "integer", "default": 10000, "description": "Max bytes to read."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_write",
            "description": "Write content to a file in the user's project sandbox. Creates the parent directory if needed. Mode 'w' overwrites, 'a' appends.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Sandbox-relative path."},
                    "content": {"type": "string", "description": "Full file contents."},
                    "mode": {"type": "string", "enum": ["w", "a"], "default": "w"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_patch",
            "description": "Apply a find/replace edit to a file. count param protects against multiple-existing matches (-1 or 0 replaces all).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "find": {"type": "string", "description": "Exact text to find."},
                    "replace": {"type": "string", "description": "Replacement text."},
                    "count": {"type": "integer", "default": 1, "description": "Max replacements. -1 = all."},
                },
                "required": ["path", "find", "replace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_content_search",
            "description": "Search for a pattern inside text files. Returns line matches with paths and line content. Recursive by default.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "directory": {"type": "string", "default": "/workspace"},
                    "recursive": {"type": "boolean", "default": True},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_exec",
            "description": "Execute a shell command inside the sandbox. stdout / stderr / exit_code returned. 30s default timeout.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string", "default": "/workspace"},
                    "timeout": {"type": "integer", "default": 30},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files inside a sandbox directory. Recursive returns full tree (may be large).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "default": "/workspace"},
                    "recursive": {"type": "boolean", "default": False},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "glob_files",
            "description": "Find files matching a glob pattern (e.g. '**/*.py'). Returns sizes and modification times.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "directory": {"type": "string", "default": "/workspace"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_delete",
            "description": "Delete a file or directory inside the user's project sandbox.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Sandbox-relative path of the file or directory to delete."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_rename",
            "description": "Rename or move a file or directory in the user's project sandbox.",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_path": {"type": "string", "description": "Current sandbox-relative path of the file or directory."},
                    "new_path": {"type": "string", "description": "Target sandbox-relative path of the file or directory."},
                },
                "required": ["old_path", "new_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "directory_create",
            "description": "Create a directory in the user's project sandbox (including intermediate directories if needed).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Sandbox-relative path of the directory to create."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "http_request",
            "description": HTTP_REQUEST_TOOL_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"], "default": "GET"},
                    "url": {"type": "string"},
                    "headers": {"type": "object", "default": {}},
                    "body": {"type": "object", "default": None},
                    "timeout": {"type": "integer", "default": 30},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "desktop",
            "description": (
                "Control the live Linux desktop (DISPLAY :1, with virtual audio sink nr_speaker). "
                "Starts the desktop automatically if not running. "
                "Supports screenshot, click, double_click, right_click, move_mouse, drag, scroll, press, write, "
                "launch, wait, screen_size, start_recording (captures video + audio to MP4), and stop_recording. "
                "By default, visual actions automatically capture an updated screenshot and attach it to your next visual context."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "screenshot", "click", "double_click", "right_click",
                            "move_mouse", "drag", "scroll", "press", "write",
                            "launch", "wait", "screen_size",
                            "start_recording", "stop_recording",
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
                    "command": {"type": "string", "description": "GUI application command to launch on DISPLAY :1 (e.g. 'chromium https://example.com' or 'xfce4-terminal')."},
                    "path": {"type": "string", "description": "Optional workspace file path to save a screenshot (.png) or screen recording (.mp4)."},
                    "fps": {"type": "integer", "minimum": 1, "maximum": 60, "default": 30, "description": "Frame rate for start_recording (1-60)."},
                    "wait_ms": {"type": "integer", "minimum": 50, "maximum": 15000, "description": "Milliseconds to wait after the action before capturing the screenshot (or duration for action='wait')."},
                    "include_screenshot": {"type": "boolean", "default": True, "description": "Automatically capture and attach a screenshot after the action."},
                },
                "required": ["action"],
            },
        },
    },
]

# Keep legacy schemas aligned with the shared store service.
from chat.store_schemas import normalize_store_schema

for _tool in BUILTIN_TOOLS:
    _function = _tool.get("function", {})
    _function["parameters"] = normalize_store_schema(_function.get("name", ""), _function.get("parameters", {}))
