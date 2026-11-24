import logging
import time

from django.core.cache import cache
from rest_framework.throttling import BaseThrottle

logger = logging.getLogger(__name__)

WINDOW_SECONDS = 1


def _allow_cached(key, limit, window=WINDOW_SECONDS):
    """Fixed-window counter backed by the configured cache (Redis in production)."""
    bucket = int(time.time() // window)
    cache_key = f"mcp-throttle:{key}:{bucket}"
    try:
        try:
            count = cache.incr(cache_key)
        except ValueError:
            if cache.add(cache_key, 1, timeout=window * 2):
                count = 1
            else:
                count = cache.incr(cache_key)
        return count <= limit
    except Exception:
        # Availability over strict limiting if the shared cache is unavailable.
        logger.warning("MCP throttle cache unavailable; allowing request", exc_info=True)
        return True


class MCPServerRateThrottle(BaseThrottle):
    """Rate limit per MCP server, shared across workers through the cache."""

    def allow_request(self, request, view) -> bool:
        server_id = self._get_server_id(request)
        if not server_id:
            return True
        rate_limit = self._get_rate_limit(server_id)
        if rate_limit is None:
            return True
        _, bucket_size = rate_limit
        return _allow_cached(f"server:{server_id}", max(1, int(bucket_size)))

    def wait(self) -> float | None:
        return 1.0

    def _get_server_id(self, request) -> str | None:
        """Extract server UUID from request."""
        if request.method == "POST" and request.path.endswith("/execute/"):
            tool_name = request.data.get("tool_name", "")
            if tool_name.startswith("mcp__"):
                parts = tool_name[5:].split("__", 1)
                if len(parts) == 2:
                    server_name = parts[0]
                    from .models import MCPServer
                    server = MCPServer.objects.filter(name=server_name, user=request.user).first()
                    if server:
                        return str(server.uuid)
        return None

    def _get_rate_limit(self, server_id: str) -> tuple[float, int] | None:
        """Get rate limit for server. Returns (tokens_per_second, bucket_size) or None for unlimited."""
        from .models import MCPServer
        try:
            MCPServer.objects.get(uuid=server_id)
            return (10.0, 20)
        except MCPServer.DoesNotExist:
            return None


class MCPGlobalRateThrottle(BaseThrottle):
    """Global MCP rate limit per user, shared across workers."""

    def allow_request(self, request, view) -> bool:
        user_id = str(request.user.uuid) if request.user and request.user.is_authenticated else request.META.get("REMOTE_ADDR", "anonymous")
        return _allow_cached(f"user:{user_id}", 100)
