"""Plugin and extension hook registry for NeuronRunner core.

By default (self-hosted OSS mode), every hook uses lightweight, free, local-Docker
implementations with zero external SaaS or multi-tenant cloud dependencies.

External distributions (such as a private cloud overlay) can register custom
providers, quota hooks, Django apps, and URL routes by setting the
``NEURONRUNNER_EXTENSION_PLUGIN`` environment variable to ``package.module:register``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
import importlib
import logging
import os
from typing import Any, Callable

logger = logging.getLogger(__name__)


def _default_ensure_balance(workspace, *, model=None, user=None) -> Decimal:
    return Decimal("0")


def _default_has_paid_balance(req) -> bool:
    from sandbox.models import Workspace
    return bool(
        req.workspace_id
        and Workspace.objects.filter(
            pk=req.workspace_id,
            memberships__user_id=req.user_id,
        ).exists()
    )


def _default_settle_request(req, cost_dec: Decimal) -> None:
    req.cost = cost_dec
    req.save(update_fields=["cost"])


def _default_resolve_plan_policy(workspace, *, user=None) -> dict[str, Any]:
    from django.conf import settings

    # Self-hosted: concurrent local Docker sandboxes per workspace; None = unlimited.
    max_concurrent = int(getattr(settings, "DOCKER_SANDBOX_MAX_CONCURRENT", 3) or 0)
    return {
        "plan": "self_hosted",
        "unlimited": True,
        "max_members": None,
        "max_sandboxes": None,
        "max_concurrent_vms": max_concurrent or None,
    }


@dataclass
class QuotaHooks:
    """Hooks for workspace resolution, usage metering, and quota checks."""

    resolve_workspace: Callable[..., Any] | None = None
    personal_workspace: Callable[..., Any] | None = None
    ensure_balance: Callable[..., Decimal] = _default_ensure_balance
    has_paid_balance: Callable[..., bool] = _default_has_paid_balance
    settle_request: Callable[..., None] = _default_settle_request
    resolve_plan_policy: Callable[..., dict[str, Any]] = _default_resolve_plan_policy
    check_workspace_quota: Callable[..., None] = lambda workspace, action, **kw: None
    is_quota_error: Callable[[BaseException], bool] = lambda exc: False
    workspace_summary: Callable[..., dict[str, Any]] = lambda workspace, **kw: {}


@dataclass
class RuntimeHooks:
    """Hooks for pluggable workspace sandbox execution runtimes."""

    providers: dict[str, Any] = field(default_factory=dict)
    is_remote_runtime_id: Callable[[str | None], bool] = lambda object_id: False
    connect_runtime: Callable[..., Any] | None = None
    create_remote_runtime: Callable[..., Any] | None = None
    is_missing_runtime_error: Callable[..., bool] = lambda exc, object_id=None: False
    attach_request_runtime: Callable[..., None] = lambda request, workspace, project: None
    get_project_runtime_uuid: Callable[[Any], str | None] = lambda sandbox: None
    resolve_selected_runtime: Callable[..., Any] = lambda workspace, runtime_uuid: None
    touch_active_runtime: Callable[[str], None] = lambda object_id: None
    sync_secrets_to_runtimes: Callable[..., int | None] | None = None
    resolve_secret_target: Callable[..., Any] = lambda workspace, target_id: None
    create_direct_terminal: Callable[..., Any] | None = None
    # (project, runtime_name, auth_payload, origin) -> connection | None. Blocking; the terminal consumer
    # runs it in a thread. A connection exposes ``descriptor()``, ``consume(challenge)`` and ``claims``.
    # Returning None falls back to the local Docker terminal; raising ValueError reports its message.
    open_direct_terminal: Callable[..., Any] | None = None
    # (project, action, path, new_path, data) -> result dict | None. Called before a workspace file operation wakes
    # the runtime; a result is returned to the caller instead, None continues as usual.
    workspace_disk_override: Callable[..., Any] | None = None
    create_port_preview: Callable[..., dict[str, Any] | None] | None = None
    close_port_preview: Callable[..., dict[str, Any] | None] | None = None
    list_preview_ports: Callable[..., list[int] | None] | None = None
    extra_agent_tools: list[dict[str, Any]] = field(default_factory=list)
    dispatch_extra_tool: Callable[..., Any] | None = None


@dataclass
class AppHooks:
    """Hooks for dynamically mounting extra Django apps, routes, and serializer fields."""

    extra_installed_apps: list[str] = field(default_factory=list)
    extra_urlpatterns: list[Any] = field(default_factory=list)
    extra_sandbox_urlpatterns: list[Any] = field(default_factory=list)
    extra_user_urlpatterns: list[Any] = field(default_factory=list)
    extra_model_urlpatterns: list[Any] = field(default_factory=list)
    extra_cors_headers: list[str] = field(default_factory=list)
    extra_allowed_hosts: list[str] = field(default_factory=list)
    extra_cors_origins: list[str] = field(default_factory=list)
    extra_config_payload: Callable[[Any], dict[str, Any]] = lambda settings_obj: {}
    extra_user_payload: Callable[..., dict[str, Any]] = lambda user, **kw: {}
    extra_admin_overview: Callable[..., dict[str, Any]] = lambda request: {}
    extra_admin_user_payload: Callable[..., dict[str, Any]] = lambda user: {}


class ExtensionRegistry:
    """Central registry inspected by core views, models, and services."""

    def __init__(self) -> None:
        self.quota = QuotaHooks()
        self.runtime = RuntimeHooks()
        self.app = AppHooks()
        self.loaded_plugins: list[str] = []


registry = ExtensionRegistry()


def resolve_workspace_hook(request, *, conversation=None):
    """Resolve the active workspace via plugin hook or core workspace_auth."""
    if registry.quota.resolve_workspace is not None:
        return registry.quota.resolve_workspace(request, conversation=conversation)
    from sandbox.services.workspace_auth import resolve_workspace
    return resolve_workspace(request, conversation=conversation)


def personal_workspace_hook(user):
    """Resolve the user's personal workspace via plugin hook or core workspace_auth."""
    if registry.quota.personal_workspace is not None:
        return registry.quota.personal_workspace(user)
    from sandbox.services.workspace_auth import personal_workspace
    return personal_workspace(user)


def expand_urlpatterns(entries: list[Any]) -> list[Any]:
    """Expand lazy (prefix, urlconf_module) tuples or callables into Django URL patterns."""
    from django.urls import include, path

    expanded: list[Any] = []
    for entry in entries:
        if callable(entry):
            expanded.extend(entry())
        elif isinstance(entry, tuple) and len(entry) == 2 and isinstance(entry[1], str):
            prefix, urlconf = entry
            expanded.append(path(prefix, include(urlconf)))
        else:
            expanded.append(entry)
    return expanded


def load_extension_plugin(settings_globals: dict[str, Any] | None = None) -> bool:
    """Load and invoke the configured extension plugin once during settings bootstrap."""
    spec = (os.environ.get("NEURONRUNNER_EXTENSION_PLUGIN") or "").strip()
    if not spec:
        return False
    if spec in registry.loaded_plugins:
        return True

    if ":" in spec:
        module_path, attr_name = spec.split(":", 1)
    else:
        module_path, attr_name = spec, "register"

    module = importlib.import_module(module_path)
    register_fn = getattr(module, attr_name)
    register_fn(registry, settings_globals)
    registry.loaded_plugins.append(spec)
    logger.info("Loaded NeuronRunner extension plugin: %s", spec)
    return True
