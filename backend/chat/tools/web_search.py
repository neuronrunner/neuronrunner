"""
web_search — search the web via Tavily Search API.

Requires TAVILY_API_KEY in .env / Django settings.
Install: pip install tavily-python

Handler signature: (user, arguments: dict) -> dict
"""
import logging
import os
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

from chat.tools import register

MAX_QUERIES = 4
SEARCH_TIMEOUT_SECONDS = 15
WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the web for current information. Batch independent queries in queries to search concurrently. Use returned snippets when sufficient; fetch only sources needing more detail.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "A single search query."},
                "queries": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": MAX_QUERIES, "description": "Independent search queries to run concurrently. Prefer this for multiple searches."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5, "description": "Maximum results per query (default 5)."},
            },
            "anyOf": [{"required": ["query"]}, {"required": ["queries"]}],
        },
    },
}


def _get_api_key():
    api_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not api_key:
        try:
            from django.conf import settings
            api_key = (getattr(settings, "TAVILY_API_KEY", None) or "").strip()
        except Exception:
            pass
    return api_key


def _search(query, limit, api_key, *, include_images=False):
    try:
        from tavily import TavilyClient

        client = TavilyClient(api_key=api_key)
        response = client.search(
            query=query,
            max_results=limit,
            search_depth="basic",
            include_answer=False,
            auto_parameters=False,
            timeout=SEARCH_TIMEOUT_SECONDS,
            **({"include_images": True, "include_image_descriptions": True} if include_images else {}),
        )

        results = []
        for item in response.get("results", []):
            url = item.get("url", "")
            if not url:
                continue
            results.append({
                "title": item.get("title", "") or url,
                "url": url,
                "snippet": str(item.get("content", "") or "")[:1500],
            })

        result = {
            "status": "ok",
            "query": query,
            "count": len(results),
            "results": results,
        }
        if include_images:
            result["images"] = response.get("images") or []
        return result

    except Exception as e:
        logger.error("Tavily search failed: %s", e)
        return {"query": query, "error": f"Search failed: {str(e)}"}


def handle(user, arguments: dict, *, include_images=False) -> dict:
    """Search independent queries concurrently, preserving the single-query response."""
    queries = arguments.get("queries")
    batched = queries is not None
    if not batched:
        queries = [arguments.get("query")]
    if not isinstance(queries, list) or not 1 <= len(queries) <= MAX_QUERIES:
        return {"error": f"queries must contain 1 to {MAX_QUERIES} strings"}
    if any(not isinstance(query, str) or not query.strip() for query in queries):
        return {"error": "query or queries must contain non-empty strings"}
    queries = list(dict.fromkeys(query.strip() for query in queries))
    try:
        limit = max(1, min(20, int(arguments.get("limit", 5))))
    except (ValueError, TypeError):
        return {"error": "limit must be an integer"}
    api_key = _get_api_key()
    if not api_key:
        return {"error": "TAVILY_API_KEY is not configured"}
    def search(query):
        return _search(query, limit, api_key, include_images=include_images)
    if not batched:
        return search(queries[0])
    with ThreadPoolExecutor(max_workers=MAX_QUERIES) as pool:
        searches = list(pool.map(search, queries))
    successes = sum("error" not in search for search in searches)
    return {
        "status": "ok" if successes == len(searches) else "partial" if successes else "error",
        "searches": searches,
        "count": sum(search.get("count", 0) for search in searches),
    }


# Auto-register
register("web_search", handle)
