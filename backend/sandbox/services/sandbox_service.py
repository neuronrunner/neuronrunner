from __future__ import annotations

import logging
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)


class SandboxBootstrapService:
    """Bootstrap personal workspaces and their shared filesystem handles."""

    @staticmethod
    def ensure_personal_workspace(user):
        """Return the user's personal team workspace, creating membership if needed."""
        from django.utils.text import slugify
        from sandbox.models import Workspace, WorkspaceMembership

        membership = (
            WorkspaceMembership.objects
            .select_related("workspace")
            .filter(user=user, role=WorkspaceMembership.ROLE_OWNER)
            .order_by("joined_at")
            .first()
        )
        if membership:
            return membership.workspace

        slug_base = slugify(getattr(user, "username", "personal"))[:45] or "personal"
        candidate = slug_base
        for index in range(1, 100):
            if not Workspace.objects.filter(owner=user, slug=candidate).exists():
                break
            candidate = f"{slug_base}-{index}"

        workspace = Workspace.objects.create(
            owner=user,
            name=f"{getattr(user, 'first_name', '') or getattr(user, 'username', 'Personal')}'s workspace",
            slug=candidate,
            storage_key=f"user-{user.pk}",
        )
        WorkspaceMembership.objects.create(
            workspace=workspace,
            user=user,
            role=WorkspaceMembership.ROLE_OWNER,
        )
        return workspace

    @staticmethod
    def ensure_workspace_sandbox(workspace):
        """Return the filesystem root for the workspace's single runtime.

        Lock the workspace while bootstrapping so empty workspaces are safe to
        open from multiple clients at once. Project handles share one runtime.
        """
        from django.db import transaction
        from sandbox.models import Sandbox, Workspace

        with transaction.atomic():
            Workspace.objects.select_for_update().get(pk=workspace.pk)
            existing = workspace.projects.filter(filesystem_path="/workspace").first()
            if existing:
                return existing
            shared = workspace.projects.order_by("created_at").first()
            slug = "files"
            suffix = 1
            while workspace.projects.filter(slug=slug).exists():
                slug = f"files-{suffix}"
                suffix += 1
            return Sandbox.objects.create(
                user=workspace.owner,
                workspace=workspace,
                slug=slug,
                display_name="Files",
                description="Shared filesystem root",
                filesystem_path="/workspace",
                sandbox_gpu=shared.sandbox_gpu if shared else "CPU",
                sandbox_cpu=shared.sandbox_cpu if shared else 0.5,
                sandbox_memory=shared.sandbox_memory if shared else 2048,
                idle_timeout_seconds=shared.idle_timeout_seconds if shared else getattr(settings, "SANDBOX_IDLE_TIMEOUT_DEFAULT", 300),
                r2_workspace_prefix=f"sandboxes/workspace-{workspace.storage_key}/",
                sandbox_object_id=shared.sandbox_object_id if shared else "",
                terminal_url=shared.terminal_url if shared else "",
                terminal_token=shared.terminal_token if shared else "",
                sandbox_last_active_at=timezone.now(),
            )

    @staticmethod
    def ensure_personal_filesystem(user):
        workspace = SandboxBootstrapService.ensure_personal_workspace(user)
        return SandboxBootstrapService.ensure_workspace_sandbox(workspace)

    @staticmethod
    def conversation_project(conversation):
        """Resolve only the conversation's linked project, never another workspace."""
        from sandbox.models import Sandbox

        return (
            Sandbox.objects.filter(conversations=conversation).order_by("created_at").first()
            or Sandbox.objects.filter(conversation=conversation).order_by("created_at").first()
        )
