"""Execute independent web reads concurrently and keep other tools sequential."""
from concurrent.futures import ThreadPoolExecutor
import json
from queue import Empty, Queue
import time

from django.db import close_old_connections, connections

MAX_PARALLEL_WEB_TOOLS = 4


def tool_arguments(tc):
    raw = tc["function"].get("arguments", {})
    try:
        args = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        return {}
    return args if isinstance(args, dict) else {}


def is_parallel_web_read(tc):
    name = tc["function"]["name"]
    args = tool_arguments(tc)
    return name in {"web_search", "image_search"} or (
        name == "http_request" and str(args.get("method") or "GET").upper() in {"GET", "HEAD"}
    )


def execute_tool_batch(service, tool_calls, streaming=True):
    """Yield (call, arguments, event, value, duration_ms) from one model turn.

    Only consecutive web reads may overlap. Writes, shell commands, and MCP
    tools remain ordering barriers. Workers never mutate chat history or phases.
    """
    from chat.builtin_tools import execute_builtin_tool, execute_builtin_tool_stream

    actor = getattr(getattr(service, 'current_request', None), 'user', None) or service.conversation.user
    index = 0
    while index < len(tool_calls):
        service._raise_if_canceled(force=True)
        req = getattr(service, "current_request", None)
        if req and getattr(req, "workspace_id", None):
            from core.extensions import registry as ext_registry
            ext_registry.quota.ensure_balance(req.workspace, model=req.model, user=req.user)
        tc = tool_calls[index]
        if not is_parallel_web_read(tc):
            args = tool_arguments(tc)
            name = tc["function"]["name"]
            started = time.monotonic()
            yield tc, args, "start", None, 0
            if name.startswith("mcp__"):
                events = [("result", json.dumps(service.execute_mcp_tool(name, args)))]
            elif streaming:
                events = execute_builtin_tool_stream(actor, name, args, conversation=service.conversation)
            else:
                events = [("result", execute_builtin_tool(actor, name, args, conversation=service.conversation))]
            for event, value in events:
                if event != "result":
                    service._raise_if_canceled()
                yield tc, args, event, json.loads(value) if event == "result" else value, (time.monotonic() - started) * 1000
            index += 1
            continue

        group = []
        while index < len(tool_calls) and is_parallel_web_read(tool_calls[index]):
            group.append(tool_calls[index])
            index += 1
        queue = Queue()

        def run(call, args):
            close_old_connections()
            started = time.monotonic()
            try:
                raw = execute_builtin_tool(actor, call["function"]["name"], args, conversation=service.conversation)
                result = json.loads(raw)
            except Exception as exc:
                result = {"error": str(exc)}
            finally:
                connections.close_all()
            queue.put((call, args, "result", result, (time.monotonic() - started) * 1000))

        pool = ThreadPoolExecutor(max_workers=MAX_PARALLEL_WEB_TOOLS)
        futures = []
        try:
            for call in group:
                service._raise_if_canceled(force=True)
                args = tool_arguments(call)
                yield call, args, "start", None, 0
                futures.append(pool.submit(run, call, args))
            remaining = len(group)
            while remaining:
                service._raise_if_canceled()
                try:
                    completed = queue.get(timeout=0.5)
                except Empty:
                    yield group[0], {}, "heartbeat", "", 0
                    continue
                remaining -= 1
                yield completed
        finally:
            for future in futures:
                future.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
