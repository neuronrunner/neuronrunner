"""Immutable attribution and command audit logging for workspace sandboxes."""
from __future__ import annotations

import ipaddress
import logging
from typing import Any

from sandbox.models import SandboxAuditLog, SandboxEvent

logger = logging.getLogger(__name__)

MAX_COMMAND_LOG_CHARS = 4000


def _valid_ip(raw: str | None) -> str | None:
    if not raw:
        return None
    candidate = raw.strip()
    if not candidate:
        return None
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def extract_client_ip_from_request(request: Any) -> str | None:
    """Return the validated client IP from a Django/DRF request."""
    if request is None:
        return None
    meta = getattr(request, "META", None) or {}
    xff = meta.get("HTTP_X_FORWARDED_FOR")
    if isinstance(xff, str) and xff.strip():
        for part in xff.split(","):
            ip = _valid_ip(part)
            if ip:
                return ip
    for key in ("HTTP_X_REAL_IP", "REMOTE_ADDR"):
        ip = _valid_ip(meta.get(key))
        if ip:
            return ip
    return None


def extract_client_ip_from_scope(scope: dict | None) -> str | None:
    """Return the validated client IP from an ASGI WebSocket scope."""
    if not scope:
        return None
    headers = {
        (k.decode("latin1").lower() if isinstance(k, bytes) else str(k).lower()): (
            v.decode("latin1") if isinstance(v, bytes) else str(v)
        )
        for k, v in (scope.get("headers") or [])
    }
    xff = headers.get("x-forwarded-for")
    if xff:
        for part in xff.split(","):
            ip = _valid_ip(part)
            if ip:
                return ip
    ip = _valid_ip(headers.get("x-real-ip"))
    if ip:
        return ip
    client = scope.get("client")
    if isinstance(client, (tuple, list)) and client:
        return _valid_ip(str(client[0]))
    return None


def extract_user_agent(request: Any = None, scope: dict | None = None) -> str:
    """Return the truncated User-Agent string from an HTTP request or ASGI scope."""
    ua = ""
    if request is not None:
        meta = getattr(request, "META", None) or {}
        ua = str(meta.get("HTTP_USER_AGENT") or "")
    elif scope is not None:
        for k, v in (scope.get("headers") or []):
            key = k.decode("latin1").lower() if isinstance(k, bytes) else str(k).lower()
            if key == "user-agent":
                ua = v.decode("latin1") if isinstance(v, bytes) else str(v)
                break
    return ua[:512]


def record_sandbox_audit(
    *,
    event_type: str,
    user: Any = None,
    user_id: str | None = None,
    workspace: Any = None,
    sandbox: Any = None,
    runtime_id: str = "",
    request: Any = None,
    scope: dict | None = None,
    ip_address: str | None = None,
    user_agent: str = "",
    command: str = "",
    metadata: dict | None = None,
) -> SandboxAuditLog | None:
    """Persist an immutable SandboxAuditLog entry; never raises to callers."""
    try:
        resolved_user = user if (user is not None and getattr(user, "is_authenticated", True)) else None
        if resolved_user is None and sandbox is not None:
            resolved_user = getattr(sandbox, "user", None)

        resolved_ws = workspace or (getattr(sandbox, "workspace", None) if sandbox is not None else None)
        resolved_ip = ip_address or extract_client_ip_from_request(request) or extract_client_ip_from_scope(scope)
        resolved_ua = (user_agent or extract_user_agent(request=request, scope=scope))[:512]

        resolved_runtime_id = (
            runtime_id or (getattr(sandbox, "sandbox_object_id", "") if sandbox is not None else "")
        )[:80]

        uid_snap = str(
            getattr(resolved_user, "pk", None)
            or user_id
            or (getattr(sandbox, "user_id", None) if sandbox is not None else None)
            or ""
        )[:64]
        email_snap = str(getattr(resolved_user, "email", "") or "")[:254]
        ws_snap = str(
            getattr(resolved_ws, "pk", None)
            or (getattr(sandbox, "workspace_id", None) if sandbox is not None else None)
            or ""
        )[:64]

        return SandboxAuditLog.objects.create(
            event_type=event_type[:40],
            user=resolved_user,
            user_id_snapshot=uid_snap,
            user_email_snapshot=email_snap,
            workspace=resolved_ws,
            workspace_id_snapshot=ws_snap,
            runtime_id=resolved_runtime_id,
            sandbox=sandbox,
            sandbox_uuid_snapshot=str(getattr(sandbox, "pk", "") or "")[:64],
            ip_address=resolved_ip,
            user_agent=resolved_ua,
            command=(command or "")[:MAX_COMMAND_LOG_CHARS],
            metadata=metadata or {},
        )
    except Exception:
        logger.warning("Failed to write SandboxAuditLog (%s)", event_type, exc_info=True)
        return None


def record_sandbox_event(
    *,
    sandbox: Any,
    event_type: str,
    payload: dict | None = None,
    duration_ms: int = 0,
    success: bool = True,
    error_message: str = "",
) -> SandboxEvent | None:
    """Persist a SandboxEvent for a sandbox; never raises to callers."""
    if sandbox is None or not getattr(sandbox, "pk", None):
        return None
    try:
        return SandboxEvent.objects.create(
            sandbox=sandbox,
            event_type=event_type[:32],
            payload=payload or {},
            duration_ms=max(0, int(duration_ms or 0)),
            success=bool(success),
            error_message=(error_message or "")[:2000],
        )
    except Exception:
        logger.warning("Failed to write SandboxEvent (%s)", event_type, exc_info=True)
        return None
