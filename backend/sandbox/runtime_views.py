"""REST API for a workspace's local Docker runtimes (self-hosted edition).

A workspace always has a ``default`` runtime. Members can launch additional
named runtimes, each its own Docker container mounting the same /workspace
folder, switch between them in the UI and stop them. Only the local Docker
provider supports this; with a remote provider the endpoints answer 404 so the
cloud edition's own runtime API stays authoritative.
"""
from __future__ import annotations

import logging

from django.shortcuts import get_object_or_404
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from sandbox.models import WorkspaceMembership
from sandbox.services.docker_sandbox import DockerSandboxError, normalize_runtime_name
from sandbox.services.runtime_provider import uses_docker
from sandbox.services.sandbox_service import SandboxBootstrapService
from sandbox.services.sandbox_session import (
    RuntimeLimitError,
    get_sandbox_manager,
    max_concurrent_runtimes,
)

logger = logging.getLogger(__name__)


def _workspace_filesystem(request, workspace_uuid):
    membership = get_object_or_404(
        WorkspaceMembership.objects.select_related("workspace"),
        workspace_id=workspace_uuid,
        user=request.user,
    )
    return membership.workspace, SandboxBootstrapService.ensure_workspace_sandbox(membership.workspace)


def _unsupported():
    return Response(
        {"error": "Named runtimes are only available with the local Docker sandbox provider.", "code": "runtimes_unsupported"},
        status=status.HTTP_404_NOT_FOUND,
    )


def _docker_error(exc: Exception):
    if isinstance(exc, RuntimeLimitError):
        return Response({"error": str(exc), "code": "runtime_limit_reached"}, status=status.HTTP_409_CONFLICT)
    return Response({"error": str(exc), "code": "runtime_unavailable"}, status=status.HTTP_503_SERVICE_UNAVAILABLE)


def _payload(workspace, project):
    manager = get_sandbox_manager()
    items = manager.list_runtimes(project)
    return {
        "items": items,
        "max_concurrent": max_concurrent_runtimes(workspace),
        "running": sum(1 for item in items if item["status"] in {"running", "starting"}),
    }


class WorkspaceRuntimesView(APIView):
    """GET lists the workspace's runtimes; POST {"name"} launches (or resumes) one."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, workspace_uuid):
        if not uses_docker():
            return _unsupported()
        workspace, project = _workspace_filesystem(request, workspace_uuid)
        try:
            return Response(_payload(workspace, project))
        except DockerSandboxError as exc:
            return _docker_error(exc)

    def post(self, request, workspace_uuid):
        if not uses_docker():
            return _unsupported()
        workspace, project = _workspace_filesystem(request, workspace_uuid)
        try:
            name = normalize_runtime_name(request.data.get("name"))
        except ValueError as exc:
            return Response({"error": str(exc), "code": "invalid_runtime_name"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            get_sandbox_manager().start_runtime(project, name)
            payload = _payload(workspace, project)
        except DockerSandboxError as exc:
            return _docker_error(exc)
        payload["runtime"] = next((item for item in payload["items"] if item["name"] == name), None)
        return Response(payload, status=status.HTTP_201_CREATED)


class WorkspaceRuntimeDetailView(APIView):
    """POST .../stop/ stops a runtime; DELETE removes a named runtime's container."""

    permission_classes = [permissions.IsAuthenticated]

    def _stop(self, request, workspace_uuid, runtime_name, *, remove: bool):
        if not uses_docker():
            return _unsupported()
        workspace, project = _workspace_filesystem(request, workspace_uuid)
        try:
            name = normalize_runtime_name(runtime_name)
        except ValueError as exc:
            return Response({"error": str(exc), "code": "invalid_runtime_name"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            get_sandbox_manager().stop_runtime(project, name, remove=remove)
            return Response(_payload(workspace, project))
        except DockerSandboxError as exc:
            if remove and "cannot be removed" in str(exc):
                return Response({"error": str(exc), "code": "default_runtime"}, status=status.HTTP_400_BAD_REQUEST)
            return _docker_error(exc)

    def post(self, request, workspace_uuid, runtime_name):
        return self._stop(request, workspace_uuid, runtime_name, remove=False)

    def delete(self, request, workspace_uuid, runtime_name):
        return self._stop(request, workspace_uuid, runtime_name, remove=True)
