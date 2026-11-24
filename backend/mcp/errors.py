"""Explain transport failures without exposing response bodies or credentials."""
import asyncio

from .url_security import UnsafeMCPURL


def error_leaves(error):
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in error_leaves(child)]
    return [error]


def connection_error_message(error):
    leaves = error_leaves(error)
    for leaf in leaves:
        if isinstance(leaf, UnsafeMCPURL):
            return str(leaf)
    for leaf in leaves:
        code = getattr(getattr(leaf, 'response', None), 'status_code', None)
        if code is not None:
            explanations = {
                401: 'MCP authorization was rejected (HTTP 401). Reconnect your account or check your API token.',
                403: 'MCP access was denied (HTTP 403). Check the permissions granted to this connector.',
                404: 'MCP endpoint was not found (HTTP 404). Check the server URL.',
                405: 'MCP endpoint rejected the connection method (HTTP 405). Check the URL and HTTP protocol.',
                429: 'MCP provider rate limit reached (HTTP 429). Wait a moment and try again.',
            }
            return explanations.get(code, f'MCP server returned HTTP {code}. Check the provider and try again.')
    for leaf in leaves:
        detail = getattr(leaf, 'detail', None)
        if isinstance(detail, dict) and isinstance(detail.get('error'), str):
            # Our OAuth errors contain curated messages, never the provider's raw body.
            return str(detail['error'])
        if isinstance(leaf, (TimeoutError, asyncio.TimeoutError)) or 'timeout' in type(leaf).__name__.lower():
            return str(leaf) if str(leaf).startswith('MCP ') else 'MCP connection timed out. Check the server and try again.'
        if isinstance(leaf, (ConnectionError, OSError)) or type(leaf).__name__ in ('ConnectError', 'ConnectFailure', 'NetworkError'):
            return 'MCP server could not be reached. Check its address and your network connection.'
        if type(leaf).__name__ in ('EndOfStream', 'ClosedResourceError', 'BrokenResourceError'):
            return 'MCP server closed the connection before verification finished. Check the endpoint and authentication.'
        # Preserve the local sandbox's intentional startup diagnostics.
        if str(leaf).startswith('MCP '):
            return str(leaf)
    return 'MCP connection failed. Check the server URL, protocol and authentication, then try again.'
