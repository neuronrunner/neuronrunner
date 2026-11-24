"""Workspace authorization and context resolution."""
from __future__ import annotations

from uuid import UUID

from django.db.models import Q
from rest_framework.exceptions import PermissionDenied, ValidationError

from sandbox.models import Sandbox, Workspace, WorkspaceMembership


def personal_workspace(user):
    from sandbox.services.sandbox_service import SandboxBootstrapService

    return SandboxBootstrapService.ensure_personal_workspace(user)


def account_scope(account):
    return {'workspace': account} if isinstance(account, Workspace) else {'user': account}


def resolve_workspace(request, *, conversation=None, manage=False):
    """Explicit context never silently falls back to a different workspace."""
    data = request.data if hasattr(request, 'data') else {}
    workspace_id = (
        getattr(request, 'headers', {}).get('X-Workspace-ID')
        or getattr(request, 'query_params', {}).get('workspace_uuid')
        or data.get('workspace_uuid')
    )
    project_id = data.get('project_uuid')
    linked_id = getattr(conversation, 'workspace_id', None)
    if not linked_id and conversation is not None:
        linked_ids = list(
            Workspace.objects.filter(
                Q(projects__conversations=conversation) | Q(projects__conversation=conversation)
            ).values_list('pk', flat=True).distinct()[:2]
        )
        if len(linked_ids) > 1:
            raise ValidationError('Conversation belongs to multiple workspaces.')
        linked_id = linked_ids[0] if linked_ids else None
    if project_id:
        try:
            project = (
                Sandbox.objects.filter(pk=UUID(str(project_id)))
                .filter(
                    Q(workspace__memberships__user=request.user)
                    | Q(workspace__isnull=True, user=request.user)
                )
                .first()
            )
        except (ValueError, TypeError):
            raise ValidationError('Invalid project UUID.')
        if not project:
            raise PermissionDenied('Project is unavailable in this workspace.')
        project_workspace_id = project.workspace_id or personal_workspace(request.user).pk
        if linked_id and linked_id != project_workspace_id:
            raise ValidationError('Conversation and project belong to different workspaces.')
        linked_id = project_workspace_id
    if workspace_id:
        try:
            workspace_id = UUID(str(workspace_id))
        except (ValueError, TypeError):
            raise ValidationError('Invalid workspace UUID.')
        if linked_id and workspace_id != linked_id:
            raise ValidationError('Request workspace does not match the conversation or project.')
    else:
        workspace_id = linked_id
    if not workspace_id:
        workspace_id = personal_workspace(request.user).pk
    membership = (
        WorkspaceMembership.objects.select_related('workspace', 'workspace__owner')
        .filter(workspace_id=workspace_id, user=request.user)
        .first()
    )
    if not membership:
        raise PermissionDenied('Workspace access denied.')
    if manage and membership.role not in ('owner', 'admin'):
        raise PermissionDenied('Only workspace owners and admins can manage workspace settings and provider keys.')
    return membership.workspace
