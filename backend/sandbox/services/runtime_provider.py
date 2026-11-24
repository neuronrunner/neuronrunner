"""Pluggable workspace sandbox runtime dispatch.

Defaults to isolated local Docker containers in self-hosted mode. External
extension plugins can register remote runtime providers via ``core.extensions``.
"""
from __future__ import annotations

from django.conf import settings

from core.extensions import registry

PROVIDER_DOCKER = "docker"


def sandbox_provider() -> str:
    return (getattr(settings, "SANDBOX_PROVIDER", PROVIDER_DOCKER) or PROVIDER_DOCKER).strip().lower()


def uses_docker() -> bool:
    return sandbox_provider() == PROVIDER_DOCKER


def uses_remote_runtime() -> bool:
    """True when a non-Docker remote runtime provider is active."""
    return sandbox_provider() != PROVIDER_DOCKER


def is_remote_runtime_id(object_id: str | None) -> bool:
    if not object_id:
        return False
    return bool(registry.runtime.is_remote_runtime_id(object_id))


def connect_runtime(object_id: str, **kwargs):
    if registry.runtime.connect_runtime is None:
        raise RuntimeError(f"No remote runtime connector registered for {object_id!r}")
    return registry.runtime.connect_runtime(object_id, **kwargs)


def create_remote_runtime(project):
    if registry.runtime.create_remote_runtime is None:
        raise RuntimeError(f"No remote runtime creator registered for provider {sandbox_provider()!r}")
    return registry.runtime.create_remote_runtime(project)


def is_missing_runtime_error(exc: BaseException, object_id: str | None = None) -> bool:
    return bool(registry.runtime.is_missing_runtime_error(exc, object_id=object_id))
