"""
Unified Application Cache and State Tracking Layer.

Provides fast, thread-safe caching for:
- Key-value data with TTL
- Warm model instances tracking
- Request cancellation tokens
- Sandbox status & file listings
"""

import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Fallback in-memory stores for thread-safe process cache
_mem_cache: dict[str, Any] = {}
_mem_ttl: dict[str, float] = {}
_mem_warm: dict[str, int] = {}
_mem_cancel: dict[str, float] = {}
_mem_sandbox_status: dict[str, dict] = {}
_mem_sandbox_files: dict[str, list] = {}
_mem_stream_state: dict[str, dict] = {}


def _get_django_cache():
    try:
        from django.core.cache import cache
        return cache
    except Exception:
        return None


# ─── General Cache ────────────────────────────────────────────────────────────

def set_cache(key: str, value: Any, timeout: Optional[int] = None) -> None:
    """Store a value in cache with optional TTL in seconds."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.set(f"nr_cache:{key}", value, timeout=timeout)
            return
        except Exception:
            pass

    _mem_cache[key] = value
    if timeout is not None:
        _mem_ttl[key] = time.time() + float(timeout)
    else:
        _mem_ttl.pop(key, None)


def get_cache(key: str) -> Optional[Any]:
    """Retrieve a value from cache if present and not expired."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            val = django_cache.get(f"nr_cache:{key}")
            if val is not None:
                return val
        except Exception:
            pass

    expire_at = _mem_ttl.get(key)
    if expire_at is not None and time.time() > expire_at:
        _mem_cache.pop(key, None)
        _mem_ttl.pop(key, None)
        return None

    return _mem_cache.get(key)


def delete_cache(key: str) -> None:
    """Delete a key from cache."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.delete(f"nr_cache:{key}")
        except Exception:
            pass

    _mem_cache.pop(key, None)
    _mem_ttl.pop(key, None)


# ─── Warm Model Tracking ──────────────────────────────────────────────────────

def get_warm_models_count(model_uuid: str) -> int:
    """Return count of active warm replicas for a model."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            count = django_cache.get(f"nr_warm:{model_uuid}")
            if count is not None:
                return int(count)
        except Exception:
            pass
    return _mem_warm.get(model_uuid, 0)


def increment_warm_model(model_uuid: str) -> int:
    """Increment active warm count for a model."""
    count = get_warm_models_count(model_uuid) + 1
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.set(f"nr_warm:{model_uuid}", count, timeout=3600)
        except Exception:
            pass
    _mem_warm[model_uuid] = count
    return count


def decrement_warm_model(model_uuid: str) -> int:
    """Decrement active warm count for a model."""
    count = max(0, get_warm_models_count(model_uuid) - 1)
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.set(f"nr_warm:{model_uuid}", count, timeout=3600)
        except Exception:
            pass
    _mem_warm[model_uuid] = count
    return count


def get_all_warm_models() -> dict:
    """Return dictionary of all tracked warm model UUIDs and counts."""
    return dict(_mem_warm)


# ─── Request Cancellation ─────────────────────────────────────────────────────

def set_request_cancelled(request_id: str, timeout: int = 3600) -> None:
    """Mark a request ID as canceled by user."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.set(f"nr_cancel:{request_id}", True, timeout=timeout)
        except Exception:
            pass
    _mem_cancel[request_id] = time.time() + float(timeout)


def is_request_cancelled(request_id: str) -> bool:
    """Check if a request ID was marked as canceled."""
    if not request_id:
        return False
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            cancelled = django_cache.get(f"nr_cancel:{request_id}")
            if cancelled:
                return True
        except Exception:
            pass

    expire_at = _mem_cancel.get(request_id)
    if expire_at is None:
        return False
    if time.time() > expire_at:
        _mem_cancel.pop(request_id, None)
        return False
    return True


# ─── Sandbox Status Tracking ──────────────────────────────────────────────────

def set_sandbox_status(sandbox_uuid: str, status: dict) -> None:
    """Set status dictionary for an active sandbox."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.set(f"nr_sandbox_status:{sandbox_uuid}", status, timeout=86400)
        except Exception:
            pass
    _mem_sandbox_status[sandbox_uuid] = status


def get_sandbox_status(sandbox_uuid: str) -> Optional[dict]:
    """Get status dictionary for a sandbox."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            st = django_cache.get(f"nr_sandbox_status:{sandbox_uuid}")
            if st is not None:
                return st
        except Exception:
            pass
    return _mem_sandbox_status.get(sandbox_uuid)


def get_all_sandbox_status() -> dict:
    """Return dictionary of all tracked sandbox statuses."""
    return dict(_mem_sandbox_status)


def clear_sandbox_status(sandbox_uuid: str) -> None:
    """Clear status dictionary for a sandbox."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.delete(f"nr_sandbox_status:{sandbox_uuid}")
        except Exception:
            pass
    _mem_sandbox_status.pop(sandbox_uuid, None)


# ─── Sandbox Files Listing Cache ──────────────────────────────────────────────

def set_sandbox_files(sandbox_uuid: str, files: list) -> None:
    """Cache the file tree listing for a sandbox."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.set(f"nr_sandbox_files:{sandbox_uuid}", files, timeout=600)
        except Exception:
            pass
    _mem_sandbox_files[sandbox_uuid] = files


def get_sandbox_files(sandbox_uuid: str) -> Optional[list]:
    """Get cached file tree listing for a sandbox."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            fl = django_cache.get(f"nr_sandbox_files:{sandbox_uuid}")
            if fl is not None:
                return fl
        except Exception:
            pass
    return _mem_sandbox_files.get(sandbox_uuid)


def clear_sandbox_files(sandbox_uuid: str) -> None:
    """Clear cached file listing for a sandbox."""
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.delete(f"nr_sandbox_files:{sandbox_uuid}")
        except Exception:
            pass
    _mem_sandbox_files.pop(sandbox_uuid, None)


# ─── Request Stream State Cache ───────────────────────────────────────────────

def set_request_stream_state(request_id: str, state: dict, timeout: int = 3600) -> None:
    """Store partial stream state (content, thinking, phases, tool_calls)."""
    if not request_id:
        return
    stored = False
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.set(f"nr_stream_state:{request_id}", state, timeout=timeout)
            stored = True
        except Exception:
            pass
    # Keep the in-process copy only as a fallback. Mirroring every snapshot in
    # memory duplicated the full stream state for the whole request lifetime.
    if not stored:
        _mem_stream_state[request_id] = state


def get_request_stream_state(request_id: str) -> Optional[dict]:
    """Retrieve partial stream state (content, thinking, phases, tool_calls)."""
    if not request_id:
        return None
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            st = django_cache.get(f"nr_stream_state:{request_id}")
            if st is not None:
                return st
        except Exception:
            pass
    return _mem_stream_state.get(request_id)


def clear_request_stream_state(request_id: str) -> None:
    """Clear partial stream state when request finishes."""
    if not request_id:
        return
    django_cache = _get_django_cache()
    if django_cache is not None:
        try:
            django_cache.delete(f"nr_stream_state:{request_id}")
        except Exception:
            pass
    _mem_stream_state.pop(request_id, None)
