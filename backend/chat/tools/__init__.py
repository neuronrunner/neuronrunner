"""
ToolRegistry — maps tool names to handler functions.

Handlers receive (user, arguments: dict) and return a dict.
The registry is populated at import time by each tool module calling register().
"""
import logging
from typing import Callable

logger = logging.getLogger(__name__)

_registry: dict[str, Callable] = {}


def register(name: str, handler: Callable):
    """Register a tool handler."""
    _registry[name] = handler
    logger.debug("Registered tool handler: %s", name)


def execute(name: str, user, arguments: dict) -> dict:
    """Execute a tool by name. Returns dict, never raises."""
    handler = _registry.get(name)
    if handler is None:
        return {"error": f"Unknown tool: {name}"}
    try:
        result = handler(user, arguments)
        if not isinstance(result, dict):
            return {"result": result}
        return result
    except Exception as e:
        logger.exception("Tool %s failed: %s", name, e)
        return {"error": str(e)}


def list_registered() -> list[str]:
    """Return names of all registered handlers."""
    return list(_registry.keys())


# ─── Auto-import all tool handler modules ─────────────────────────────────────
# Each module calls register() at import time to populate the registry.

import chat.builtin_tools  # noqa: E402,F401 — registers memory/note/session handlers

try:
    import chat.tools.web_search  # noqa: E402,F401 — registers web_search handler
except ImportError:
    logger.warning("web_search tool module not available")

try:
    import chat.tools.browser  # noqa: E402,F401 — registers built-in browser handler
except ImportError:
    logger.warning("browser tool module not available")
