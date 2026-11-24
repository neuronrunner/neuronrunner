"""
MCP client service – connect, discover tools, execute calls.
"""
import asyncio
import json
import logging
import threading
from contextlib import asynccontextmanager
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_thread_local = threading.local()
_http_client: Optional[httpx.AsyncClient] = None
_http_client_lock = threading.Lock()


def _get_event_loop() -> asyncio.AbstractEventLoop:
    """Get or create thread-local event loop."""
    if not hasattr(_thread_local, 'loop') or _thread_local.loop.is_closed():
        _thread_local.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_thread_local.loop)
    return _thread_local.loop


def _get_http_client() -> httpx.AsyncClient:
    """Get or create shared HTTP client with connection pooling."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        with _http_client_lock:
            if _http_client is None or _http_client.is_closed:
                limits = httpx.Limits(max_keepalive_connections=20, max_connections=100)
                timeout = httpx.Timeout(30.0, connect=10.0)
                _http_client = httpx.AsyncClient(limits=limits, timeout=timeout)
    return _http_client


async def _close_http_client():
    """Close the shared HTTP client."""
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None


def _run_async(coro, timeout: float = 15.0):
    """Bridge async → sync: run coroutine in thread-local event loop with timeout."""
    loop = _get_event_loop()
    try:
        return loop.run_until_complete(asyncio.wait_for(coro, timeout=timeout))
    except asyncio.TimeoutError:
        raise TimeoutError(f"MCP operation timed out after {timeout} seconds")
    except Exception as error:
        # AnyIO transport cleanup wraps even one error in a TaskGroup. Preserve
        # the actual exception so HTTP auth retries and timeout handling work.
        while isinstance(error, ExceptionGroup) and len(error.exceptions) == 1:
            error = error.exceptions[0]
        raise error from None


def discover_tools(command: str | None, url: str | None, transport: str,
                   env_json: dict | None = None, timeout: float = 15.0,
                   http_transport: str = 'sse', headers_json: dict | None = None,
                   user_uuid: str | None = None, workspace_uuid: str | None = None,
                   server_uuid: str | None = None) -> list[dict]:
    """Connect to MCP server, return list of tool dicts."""
    logger.info("Discovering tools", extra={"transport": transport})
    if transport == 'stdio' and command:
        from .sandbox_transport import run_stdio
        return run_stdio(command, env_json, user_uuid=user_uuid,
                         workspace_uuid=workspace_uuid, timeout=timeout)
    elif transport == 'http' and url:
        return _oauth_http_call(server_uuid, url, headers_json,
            lambda headers: _run_async(_discover_http(url, http_transport, headers), timeout))
    else:
        raise ValueError(f"Invalid transport configuration: {transport}")


def execute_tool(transport: str, command: str | None, url: str | None,
                 env_json: dict | None, tool_name: str,
                 arguments: dict, timeout: float = 15.0,
                 server_uuid: str | None = None, user_uuid: str | None = None,
                 http_transport: str = 'sse', headers_json: dict | None = None,
                 workspace_uuid: str | None = None) -> tuple[str, int]:
    """Execute a tool call and return (result, duration_ms)."""
    import time
    start = time.perf_counter()
    logger.info("Executing tool", extra={"transport": transport, "tool": tool_name})
    try:
        if transport == 'stdio' and command:
            from .sandbox_transport import run_stdio
            result = run_stdio(command, env_json, user_uuid=user_uuid,
                               workspace_uuid=workspace_uuid, timeout=timeout,
                               tool_name=tool_name, arguments=arguments)
        elif transport == 'http' and url:
            result = _oauth_http_call(server_uuid, url, headers_json,
                lambda headers: _run_async(_execute_http(url, tool_name, arguments, http_transport, headers), timeout))
        else:
            raise ValueError(f"Invalid transport configuration: {transport}")
        duration_ms = int((time.perf_counter() - start) * 1000)
        return result, duration_ms
    except Exception:
        duration_ms = int((time.perf_counter() - start) * 1000)
        raise


def _oauth_http_call(server_uuid, url, headers, operation):
    try:
        return operation(headers)
    except Exception as error:
        def unauthorized(exc):
            return getattr(getattr(exc, 'response', None), 'status_code', None) == 401 or any(
                unauthorized(child) for child in getattr(exc, 'exceptions', ()))
        if not server_uuid or not unauthorized(error):
            raise
        from .models import MCPServer
        from .oauth import server_headers
        server = MCPServer.objects.filter(pk=server_uuid, url=url, auth_type='oauth').first()
        if not server:
            raise
        # Retry only once, including providers that omit expires_in or expire early.
        return operation(server_headers(server, force_refresh=True))


@asynccontextmanager
async def _http_transport(url: str, transport: str, headers: dict | None):
    from .url_security import validate_mcp_url

    await asyncio.to_thread(validate_mcp_url, url)
    if transport == 'streamable-http':
        import httpx2
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import MCP_DEFAULT_SSE_READ_TIMEOUT, create_mcp_http_client
        async with create_mcp_http_client(headers=headers or {}) as client:
            if isinstance(client, httpx2.AsyncClient):
                # Force IPv4 transport and a 5s connect timeout so dual-stack hosts with
                # blackholed IPv6 (e.g. mcp.exa.ai) do not stall the 30s default timeout.
                await client._transport.aclose()
                client._transport = httpx2.AsyncHTTPTransport(local_address='0.0.0.0')
                client.timeout = httpx2.Timeout(30.0, connect=5.0, read=MCP_DEFAULT_SSE_READ_TIMEOUT)

            rejected_response = None

            async def capture_rejection(response):
                nonlocal rejected_response
                if response.request.method == 'POST' and response.status_code in (401, 403, 429):
                    rejected_response = response

            # SDK 2.x converts these HTTP failures into a generic JSON-RPC error.
            # Retain the status so OAuth refresh and error reporting still work.
            client.event_hooks.setdefault('response', []).append(capture_rejection)
            try:
                # SDK 1.x also yields a session-id callback; SDK 2.x yields two streams.
                async with streamable_http_client(url, http_client=client) as (read, write, *_):
                    yield read, write
            except Exception:
                if rejected_response is not None:
                    rejected_response.raise_for_status()
                raise
    elif transport == 'sse':
        from mcp.client.sse import sse_client
        async with sse_client(url, headers=headers or {}) as streams:
            yield streams
    else:
        raise ValueError(f'Unsupported HTTP transport: {transport}')


async def _discover_http(url: str, transport: str = 'sse', headers: dict | None = None) -> list[dict]:
    try:
        from mcp.client.session import ClientSession
    except ImportError:
        raise ImportError("Please install the mcp package: pip install mcp")

    async with _http_transport(url, transport, headers) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return [_tool_to_dict(t) for t in result.tools]


async def _execute_http(url: str, tool_name: str, arguments: dict,
                        transport: str = 'sse', headers: dict | None = None) -> str:
    from mcp.client.session import ClientSession

    async with _http_transport(url, transport, headers) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments)
            return _format_tool_result(result)


def _tool_to_dict(tool) -> dict:
    input_schema = getattr(tool, 'input_schema', None) or getattr(tool, 'inputSchema', None) or {}
    return {
        'name': tool.name,
        'description': getattr(tool, 'description', '') or '',
        'input_schema': input_schema,
    }


def _format_tool_result(result) -> str:
    if hasattr(result, 'content') and result.content:
        texts = []
        for item in result.content:
            if hasattr(item, 'text'):
                texts.append(item.text)
            elif hasattr(item, 'data'):
                texts.append(str(item.data))
            else:
                texts.append(str(item))
        return '\n'.join(texts)
    return json.dumps({'result': str(result)})
