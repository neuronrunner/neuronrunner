"""Common utilities for chat services."""
import hashlib
import json
import logging

from asgiref.sync import sync_to_async
from django.conf import settings
from openai import OpenAI
from rest_framework import renderers

logger = logging.getLogger(__name__)


class SSERenderer(renderers.BaseRenderer):
    """Custom renderer for Server-Sent Events."""
    media_type = 'text/event-stream'
    format = 'sse'
    charset = None  # SSE is binary data

    def render(self, data, accepted_media_type=None, renderer_context=None):
        # Bypass DRF's rendering since we use StreamingHttpResponse directly
        return b''


def sse_event(event: str, data_obj: dict) -> str:
    """Format data as a Server-Sent Event."""
    return f"event: {event}\ndata: {json.dumps(data_obj)}\n\n"


import asyncio


async def async_streaming_response(sync_gen):
    """Wrap a sync generator as an async generator for proper ASGI streaming.

    Django's ASGI handler calls list() on sync generators (consuming the entire
    response before sending), which breaks SSE streaming. Using an async generator
    forces Django to use the async-for path, yielding each chunk immediately.
    Periodically emits keep-alive comments while waiting for sync_gen to prevent
    proxies, load balancers, and clients from timing out during long tool calls.
    """
    sentinel = object()
    while True:
        fetch_task = asyncio.create_task(
            sync_to_async(lambda: next(sync_gen, sentinel), thread_sensitive=False)()
        )
        while not fetch_task.done():
            done, _ = await asyncio.wait([fetch_task], timeout=5.0)
            if not done:
                yield ": keep-alive\n\n"

        chunk = await fetch_task
        if chunk is sentinel:
            break
        yield chunk


def build_parent_chain(message) -> list:
    """Build the message chain from parent to current message."""
    from chat.models import Message

    chain = []
    while message:
        chain.append(message)
        if isinstance(message, Message):
            # Walk by id and load only the fields used below. Accessing
            # ``message.parent`` loaded every column (including search_vector
            # and large JSON fields) for each ancestor.
            parent_id = message.parent_id
            message = (
                Message.objects
                .only('uuid', 'parent_id', 'role', 'content', 'tool_calls')
                .filter(pk=parent_id)
                .first()
                if parent_id else None
            )
        else:
            message = message.parent
    from chat.tools.view_image import image_context_from_tools
    from chat.services.tool_history import tool_history_text
    messages = []
    for message in reversed(chain):
        content = message.content
        if message.role == "assistant":
            activity = tool_history_text(getattr(message, "tool_calls", None))
            if activity:
                content = f"{content}\n\n{activity}"
        messages.append({"role": message.role, "content": content})
        if message.role == "assistant":
            context = image_context_from_tools(getattr(message, "tool_calls", None))
            if context:
                messages.append(context)
    return messages


def _fallback_title(content: str) -> str:
    """Generate a clean fallback title from user content if AI title generation is unavailable."""
    if not content:
        return "Untitled Conversation"
    first_line = " ".join(content.strip().splitlines()[0].split())[:60].strip("\"'").strip()
    return first_line if first_line else "Untitled Conversation"


def generate_title(
    content: str,
    is_image: bool = False,
    *,
    api_key: str,
    base_url: str,
    model: str,
) -> str:
    """
    Generate a conversation title with the workspace's own key.

    Args:
        content: The content to generate title from (message content or image prompt)
        is_image: Whether this is for an image generation conversation
        api_key, base_url, model: Workspace credentials from ``auxiliary_target``

    Returns:
        Generated title string or fallback title from content
    """
    try:
        openai_client = OpenAI(
            api_key=api_key,
            base_url=base_url or None,
            timeout=15.0,
            max_retries=0,
        )

        if is_image:
            user_prompt = f"Generate a title in 3 words for this image prompt: {content}"
        else:
            user_prompt = f"Generate a title in 3 words for this: {content[:200]}"

        create_kwargs = {
            "model": model,
            "messages": [
                {"role": "system", "content": "Write a concise 3–6 word title in the user's language. No punctuation. Respond with only the short title and nothing else."},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": 60,
            "extra_body": {"reasoning": {"effort": "none"}},
        }
        try:
            response = openai_client.chat.completions.create(**create_kwargs)
        except Exception:
            create_kwargs.pop("extra_body", None)
            response = openai_client.chat.completions.create(**create_kwargs)

        raw = response.choices[0].message.content if response.choices else None
        if raw:
            cleaned = raw.strip().strip('"\'').strip()
            if cleaned:
                return cleaned
        return _fallback_title(content)
    except Exception as e:
        logger.warning(f"Failed to generate title: {e}")
        return _fallback_title(content)

def fallback_title(content: str) -> str:
    """Title from the message text itself, used when no LLM may generate one."""
    return _fallback_title(content)


def embedding_model_name() -> str:
    """One provider/model per embedding space; text search handles outages."""
    return getattr(settings, "MEMORY_EMBEDDING_MODEL", "") or ""


def get_vector(content: str) -> list:
    """Generate an embedding without silently switching embedding spaces."""
    configured = embedding_model_name()
    if not configured or ":" not in configured:
        return []
    try:
        provider, model_name = configured.split(":", 1)
        if provider == "openrouter":
            if not getattr(settings, "OPENROUTER_API_KEY", None):
                return []
            openai_client = OpenAI(
                api_key=settings.OPENROUTER_API_KEY,
                base_url=settings.OPENROUTER_BASE_URL or None,
                timeout=15, max_retries=0,
            )
            response = openai_client.embeddings.create(
                model=model_name,
                input=content,
            )
            return response.data[0].embedding
        if provider == "openai":
            if not getattr(settings, "OPENAI_API_KEY", None):
                return []
            openai_client = OpenAI(
                api_key=settings.OPENAI_API_KEY,
                base_url=getattr(settings, "OPENAI_BASE_URL", None) or None,
                timeout=15, max_retries=0,
            )
            response = openai_client.embeddings.create(
                model=model_name,
                input=content,
            )
            return response.data[0].embedding
        logger.warning("Unsupported memory embedding provider: %s", provider)
    except Exception:
        logger.warning("Memory embedding unavailable")
    return []


EMBEDDING_CACHE_TTL = 300


def get_vector_cached(content: str, user_id: str) -> list:
    """Get vector embedding with cache to avoid redundant API calls."""
    if not content:
        return []

    digest = hashlib.sha256(f"{embedding_model_name()}:{content}".encode()).hexdigest()
    key = f"embed:{user_id}:{digest}"

    try:
        from utils.cache import get_cache as cache_get
        cached = cache_get(key)
        if cached is not None:
            return cached
    except Exception:
        pass

    vector = get_vector(content)
    if vector:
        try:
            from utils.cache import set_cache as cache_set
            cache_set(key, vector, timeout=EMBEDDING_CACHE_TTL)
        except Exception:
            pass

    return vector


def generate_thinking_summary(
    thinking_content: str,
    *,
    api_key: str,
    base_url: str,
    model: str,
) -> str | None:
    """
    Generate a one-sentence summary of thinking/reasoning content.

    Args:
        thinking_content: The full thinking/reasoning text
        api_key, base_url, model: Workspace credentials from ``auxiliary_target``

    Returns:
        One-sentence summary string, or None if generation fails
    """
    if not thinking_content or not thinking_content.strip():
        return None

    # Trim very long thinking to avoid token waste
    content_for_summary = thinking_content.strip()[:2000]

    try:
        openai_client = OpenAI(
            api_key=api_key,
            base_url=base_url or None,
            timeout=15.0,
            max_retries=0,
        )

        response = openai_client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Summarize the assistant's reasoning in 3-8 words, like a short title. "
                        "Be ultra concise. "
                        "Output ONLY the short phrase, no prefix, no punctuation at the end."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Reasoning content:\n\n{content_for_summary}",
                },
            ],
            max_tokens=20,
            temperature=0.3,
        )
        summary = response.choices[0].message.content
        if summary:
            return summary.strip().rstrip(".")
        return None
    except Exception as e:
        logger.warning(f"Failed to generate thinking summary: {e}")
        return None
