"""REST views for the sandbox runtime projects and file tools."""
from __future__ import annotations

from authentication.github_connection import get_github_connection
import logging
import time
import uuid
from datetime import timedelta
from pathlib import PurePosixPath

from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils.text import slugify
from django.utils import timezone
from model.models import Model, ModelDownloadTask
from model.serializers import ModelSerializer
from openai import OpenAI
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.throttling import UserRateThrottle

from .services.project_git import (
    GitInitializationError,
    configure_github_git,
    initialize_project_repository,
    repository_clone_command,
)
from .services.runtime_provider import uses_remote_runtime
from .models import Sandbox, SandboxEvent, Workspace, WorkspaceInvitation, WorkspaceMembership
from .serializers import (
    SandboxEventSerializer,
    SandboxSerializer,
    WorkspaceInvitationSerializer,
    WorkspaceMemberSerializer,
    WorkspaceSerializer,
)

logger = logging.getLogger(__name__)


# ─── Helpers ────────────────────────────────────────────────────────────────────

def _is_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def _accessible_workspaces(user):
    return Workspace.objects.filter(memberships__user=user).distinct()


def _accessible_projects(user):
    if _is_admin(user):
        return Sandbox.objects.all()
    return Sandbox.objects.filter(
        Q(workspace__isnull=True, user=user) | Q(workspace__memberships__user=user)
    ).distinct()


def _get_accessible_project(user, project_uuid):
    return get_object_or_404(_accessible_projects(user), uuid=project_uuid)


def _has_running_vm(project) -> bool:
    """In self-hosted Docker mode, containers start on demand for any workspace."""
    return bool(project and getattr(project, "workspace_id", None))


def _no_vm_response():
    return Response(
        {
            "error": "Workspace runtime is unavailable.",
            "code": "runtime_unavailable",
        },
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


def _resolve_and_wake_vm(workspace, user, vm_uuid=None, *, timeout=90):
    """No-op in local Docker mode; containers start on demand."""
    return None


def _bind_workspace_runtime_vm(sandbox_obj, vm) -> None:
    """No-op in local Docker mode."""
    return None


def _get_workspace_membership(user, workspace_uuid):
    return get_object_or_404(
        WorkspaceMembership.objects.select_related("workspace", "user"),
        workspace_id=workspace_uuid,
        user=user,
    )


def _resolve_user_tier(user) -> str:
    """Return the user's tier string: 'free', 'pro', or 'enterprise'."""
    from .services.pricing import resolve_user_tier

    return resolve_user_tier(user)


def _clamp_idle_timeout(requested: int, tier: str, gpu: str = "cpu") -> int:
    """Clamp idle_timeout_seconds to the tier limits from settings."""
    limits = getattr(settings, "SANDBOX_IDLE_TIMEOUT_LIMITS", {})
    minimum = getattr(settings, "SANDBOX_IDLE_TIMEOUT_MIN", 5)
    default = getattr(settings, "SANDBOX_IDLE_TIMEOUT_DEFAULT", 300)

    tier_limits = limits.get(tier, {"cpu": 300})
    maximum = tier_limits.get("cpu", default) if isinstance(tier_limits, dict) else tier_limits

    if requested < minimum:
        return minimum
    if requested > maximum:
        return maximum
    return requested


def _handle_dead_sandbox(sandbox_uuid, exc):
    """Clear stale sandbox_object_id when sandbox is dead. Returns True if handled."""
    exc_str = str(exc).lower()
    if "not found" in exc_str or "conflict" in exc_str or "terminated" in exc_str:
        project = Sandbox.objects.filter(uuid=sandbox_uuid).first()
        if project:
            if project.sandbox_object_id.startswith('vm-'):
                # A process/provider error is not evidence that the durable
                # resource was deleted. Preserve the ID and its disk.
                return False
            from sandbox.services.sandbox_session import _workspace_projects
            _workspace_projects(project).update(sandbox_object_id="", terminal_url="", terminal_token="")
        logger.warning("Cleared dead sandbox %s: %s", sandbox_uuid, exc)
        return True
    return False


def _normalize_project_path(value: str) -> str:
    """Return a safe absolute directory within the shared workspace."""
    raw = (value or "").strip()
    path = PurePosixPath(raw)
    if not raw.startswith("/workspace/") or len(path.parts) < 3 or ".." in path.parts:
        raise ValueError("filesystem_path must be a directory inside /workspace")
    return "/" + "/".join(part for part in path.parts if part != "/")


def _register_cloned_project(user, source, target_path):
    """Register the completed clone without initializing Git or another runtime."""
    from sandbox.services.sandbox_service import SandboxBootstrapService

    workspace = source.workspace or SandboxBootstrapService.ensure_personal_workspace(source.user)
    with transaction.atomic():
        Workspace.objects.select_for_update().get(pk=workspace.pk)
        existing = workspace.projects.filter(filesystem_path=target_path).first()
        if existing:
            return existing
        shared = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
        display_name = PurePosixPath(target_path).name[:120]
        slug_base = slugify(display_name)[:50] or "project"
        candidate = slug_base
        suffix = 1
        while workspace.projects.filter(slug=candidate).exists():
            candidate = f"{slug_base}-{suffix}"
            suffix += 1
        created = Sandbox.objects.create(
            user=user,
            workspace=workspace,
            slug=candidate,
            display_name=display_name,
            filesystem_path=target_path,
            sandbox_gpu=shared.sandbox_gpu,
            sandbox_cpu=shared.sandbox_cpu,
            sandbox_memory=shared.sandbox_memory,
            idle_timeout_seconds=shared.idle_timeout_seconds,
            sandbox_object_id=shared.sandbox_object_id,
            terminal_url=shared.terminal_url,
            terminal_token=shared.terminal_token,
            sandbox_last_active_at=timezone.now(),
            r2_workspace_prefix=f"sandboxes/workspace-{workspace.storage_key}/{target_path.removeprefix('/workspace/')}/",
        )
        _init_project_suggestions_on_create(created)
        return created


def _workspace_with_members_and_invitations(workspace_uuid):
    return Workspace.objects.prefetch_related(
        "memberships__user",
        "invitations__invited_by",
    ).get(pk=workspace_uuid)


def _send_workspace_invitation_email(invitation):
    accept_url = (
        f"{settings.FRONTEND_BASE_URL}/workspaces/invitations?token={invitation.token}"
    )
    sender_name = invitation.invited_by.get_full_name() or invitation.invited_by.username
    send_mail(
        subject=f"{sender_name} invited you to {invitation.workspace.name}",
        message=(
            f"{sender_name} invited you to join the {invitation.workspace.name} workspace "
            f"as a {invitation.role}.\n\n"
            "To join, sign in or create an account with this email address, then accept "
            f"the invitation here:\n{accept_url}\n\n"
            f"This invitation expires on {invitation.expires_at:%Y-%m-%d %H:%M %Z}."
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[invitation.email],
        fail_silently=False,
    )


# ─── GPU catalogue ───────────────────────────────────────────────────────────────

class ModelGPUOptionsView(APIView):
    """Tier-aware catalogue (GPU options deprecated, returns empty list)."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        tier = _resolve_user_tier(request.user)
        idle_limits = getattr(settings, "SANDBOX_IDLE_TIMEOUT_LIMITS", {}).get(
            tier, {"cpu": 300}
        )
        return Response({
            "tier": tier,
            "gpus": [],
            "idle_timeout_limits": idle_limits,
            "idle_timeout_default": getattr(settings, "SANDBOX_IDLE_TIMEOUT_DEFAULT", 300),
            "idle_timeout_min": getattr(settings, "SANDBOX_IDLE_TIMEOUT_MIN", 5),
        })


# ─── Sandbox CRUD ───────────────────────────────────────────────────────────────

class WorkspaceListCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        workspaces = (
            _accessible_workspaces(request.user)
            .prefetch_related("memberships__user", "invitations__invited_by")
            .order_by("-updated_at")
        )
        if not workspaces.exists():
            from sandbox.services.sandbox_service import SandboxBootstrapService
            SandboxBootstrapService.ensure_personal_workspace(request.user)
            workspaces = (
                _accessible_workspaces(request.user)
                .prefetch_related("memberships__user", "invitations__invited_by")
                .order_by("-updated_at")
            )
        return Response(WorkspaceSerializer(workspaces, many=True, context={"request": request}).data)

    def post(self, request):
        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"error": "Workspace name is required."}, status=400)

        slug_base = slugify(request.data.get("slug") or name)[:50] or "workspace"
        candidate = slug_base
        for index in range(1, 100):
            if not Workspace.objects.filter(owner=request.user, slug=candidate).exists():
                break
            candidate = f"{slug_base}-{index}"
        else:
            return Response({"error": "Could not allocate a unique workspace slug."}, status=400)

        raw_pic = request.FILES.get("profile_picture")
        if raw_pic and hasattr(raw_pic, "size") and raw_pic.size > settings.PROFILE_PICTURE_MAX_SIZE:
            return Response(
                {"error": f"Image file too large. Size cannot exceed {settings.PROFILE_PICTURE_MAX_SIZE / (1024 * 1024)} MB."},
                status=400,
            )

        workspace = Workspace.objects.create(
            name=name,
            slug=candidate,
            owner=request.user,
            profile_picture=raw_pic if raw_pic else None,
        )
        WorkspaceMembership.objects.create(
            workspace=workspace,
            user=request.user,
            role=WorkspaceMembership.ROLE_OWNER,
        )
        workspace = _workspace_with_members_and_invitations(workspace.pk)
        return Response(
            WorkspaceSerializer(workspace, context={"request": request}).data,
            status=201,
        )


class WorkspaceDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def patch(self, request, workspace_uuid):
        membership = _get_workspace_membership(request.user, workspace_uuid)
        if membership.role not in (WorkspaceMembership.ROLE_OWNER, WorkspaceMembership.ROLE_ADMIN):
            return Response({"error": "Only workspace admins can update this workspace."}, status=403)

        workspace = membership.workspace

        if "name" in request.data:
            name = (request.data.get("name") or "").strip()
            if not name:
                return Response({"error": "Workspace name is required."}, status=400)
            workspace.name = name

        if "profile_picture" in request.data or "profile_picture" in request.FILES:
            raw_pic = request.FILES.get("profile_picture")
            if raw_pic is None and "profile_picture" in request.data:
                val = request.data.get("profile_picture")
                if val in ("", None, "null"):
                    raw_pic = None
                else:
                    raw_pic = val

            if raw_pic:
                if hasattr(raw_pic, "size") and raw_pic.size > settings.PROFILE_PICTURE_MAX_SIZE:
                    return Response(
                        {"error": f"Image file too large. Size cannot exceed {settings.PROFILE_PICTURE_MAX_SIZE / (1024 * 1024)} MB."},
                        status=400,
                    )
                if workspace.profile_picture:
                    try:
                        workspace.profile_picture.delete(save=False)
                    except Exception:
                        pass
                workspace.profile_picture = raw_pic
            else:
                if workspace.profile_picture:
                    try:
                        workspace.profile_picture.delete(save=False)
                    except Exception:
                        pass
                workspace.profile_picture = None

        workspace.save()
        workspace = _workspace_with_members_and_invitations(workspace_uuid)
        return Response(WorkspaceSerializer(workspace, context={"request": request}).data)

    def delete(self, request, workspace_uuid):
        membership = _get_workspace_membership(request.user, workspace_uuid)
        if membership.role != WorkspaceMembership.ROLE_OWNER:
            return Response({"error": "Only the workspace owner can delete it."}, status=403)
        if _accessible_workspaces(request.user).count() <= 1:
            return Response({"error": "Your only workspace cannot be deleted."}, status=400)
        membership.workspace.delete()
        return Response(status=204)


class WorkspaceMembersView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'send_invitation'

    def get(self, request, workspace_uuid):
        membership = _get_workspace_membership(request.user, workspace_uuid)
        members = membership.workspace.memberships.select_related("user").all()
        return Response(WorkspaceMemberSerializer(members, many=True).data)

    def post(self, request, workspace_uuid):
        membership = _get_workspace_membership(request.user, workspace_uuid)
        if membership.role not in (WorkspaceMembership.ROLE_OWNER, WorkspaceMembership.ROLE_ADMIN):
            return Response({"error": "Only workspace admins can add members."}, status=403)

        email = (request.data.get("email") or "").strip().lower()
        role = (request.data.get("role") or WorkspaceMembership.ROLE_MEMBER).lower()
        if role not in (WorkspaceMembership.ROLE_ADMIN, WorkspaceMembership.ROLE_MEMBER):
            return Response({"error": "Role must be admin or member."}, status=400)
        if not email:
            return Response({"error": "Member email is required."}, status=400)

        try:
            validate_email(email)
        except ValidationError:
            return Response({"error": "Enter a valid email address."}, status=400)
        if membership.workspace.memberships.filter(user__email__iexact=email).exists():
            return Response({"error": "That email already belongs to a workspace member."}, status=400)

        expires_at = timezone.now() + timedelta(days=7)
        try:
            with transaction.atomic():
                invitation = (
                    WorkspaceInvitation.objects.select_for_update()
                    .filter(
                        workspace=membership.workspace,
                        email__iexact=email,
                        status=WorkspaceInvitation.STATUS_PENDING,
                    )
                    .first()
                )
                if invitation:
                    invitation.email = email
                    invitation.role = role
                    invitation.invited_by = request.user
                    invitation.token = uuid.uuid4()
                    invitation.expires_at = expires_at
                    invitation.save(
                        update_fields=["email", "role", "invited_by", "token", "expires_at", "updated_at"],
                    )
                    status_code = 200
                else:
                    invitation = WorkspaceInvitation.objects.create(
                        workspace=membership.workspace,
                        email=email,
                        role=role,
                        invited_by=request.user,
                        expires_at=expires_at,
                    )
                    status_code = 201
                _send_workspace_invitation_email(invitation)
        except Exception:
            logger.exception("Unable to send workspace invitation for %s", email)
            return Response({"error": "Invitation email could not be sent. Please try again."}, status=502)

        return Response(WorkspaceInvitationSerializer(invitation).data, status=status_code)


class WorkspaceInvitationAcceptView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, token):
        invitation = get_object_or_404(
            WorkspaceInvitation.objects.select_related("workspace", "invited_by"),
            token=token,
        )
        if invitation.email.casefold() != (request.user.email or "").strip().casefold():
            return Response(
                {"error": "Sign in with the email address that received this invitation."},
                status=403,
            )
        if invitation.expires_at <= timezone.now():
            if invitation.status == WorkspaceInvitation.STATUS_PENDING:
                invitation.status = WorkspaceInvitation.STATUS_EXPIRED
                invitation.save(update_fields=["status", "updated_at"])
            return Response({"error": "This workspace invitation has expired."}, status=410)
        if invitation.status != WorkspaceInvitation.STATUS_PENDING:
            return Response({"error": "This workspace invitation is no longer pending."}, status=409)

        with transaction.atomic():
            WorkspaceMembership.objects.update_or_create(
                workspace=invitation.workspace,
                user=request.user,
                defaults={"role": invitation.role},
            )
            invitation.status = WorkspaceInvitation.STATUS_ACCEPTED
            invitation.save(update_fields=["status", "updated_at"])
            Workspace.objects.filter(pk=invitation.workspace_id).update(updated_at=timezone.now())

        workspace = _workspace_with_members_and_invitations(invitation.workspace_id)
        return Response(WorkspaceSerializer(workspace, context={"request": request}).data)


class WorkspaceMemberDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def delete(self, request, workspace_uuid, user_uuid):
        membership = _get_workspace_membership(request.user, workspace_uuid)
        if membership.role not in (WorkspaceMembership.ROLE_OWNER, WorkspaceMembership.ROLE_ADMIN):
            return Response({"error": "Only workspace admins can remove members."}, status=403)

        target = get_object_or_404(
            WorkspaceMembership,
            workspace_id=workspace_uuid,
            user__uuid=user_uuid,
        )
        if target.role == WorkspaceMembership.ROLE_OWNER:
            return Response({"error": "The workspace owner cannot be removed."}, status=400)
        if membership.role == WorkspaceMembership.ROLE_ADMIN and target.role == WorkspaceMembership.ROLE_ADMIN:
            return Response({"error": "Admins cannot remove other admins."}, status=403)
        # Members share a runtime. Stop it before removal so detached commands
        # started by the departing member cannot keep accessing workspace data.
        runtime_project = Sandbox.objects.filter(workspace_id=workspace_uuid).exclude(sandbox_object_id="").first()
        if runtime_project:
            from sandbox.services.sandbox_session import get_sandbox_manager
            get_sandbox_manager().close_session_immediately(runtime_project)
        target.delete()
        return Response(status=204)


class WorkspaceInvitationDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def delete(self, request, workspace_uuid, invitation_uuid):
        membership = _get_workspace_membership(request.user, workspace_uuid)
        if membership.role not in (WorkspaceMembership.ROLE_OWNER, WorkspaceMembership.ROLE_ADMIN):
            return Response({"error": "Only workspace admins can cancel invitations."}, status=403)

        invitation = get_object_or_404(
            WorkspaceInvitation,
            workspace_id=workspace_uuid,
            uuid=invitation_uuid,
        )
        invitation.delete()
        return Response(status=204)


class SandboxListCreateView(generics.ListCreateAPIView):
    serializer_class = SandboxSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = _accessible_projects(self.request.user).exclude(filesystem_path="/workspace")
        workspace_uuid = self.request.query_params.get("workspace_uuid")
        if workspace_uuid:
            queryset = queryset.filter(workspace_id=workspace_uuid)
        return queryset.order_by("-updated_at")

    def perform_create(self, serializer):
        from rest_framework.exceptions import APIException, ValidationError as ApiValidationError
        from sandbox.services.sandbox_service import SandboxBootstrapService

        workspace_uuid = self.request.data.get("workspace_uuid")
        if workspace_uuid:
            workspace = get_object_or_404(_accessible_workspaces(self.request.user), uuid=workspace_uuid)
        else:
            workspace = SandboxBootstrapService.ensure_personal_workspace(self.request.user)
        try:
            filesystem_path = _normalize_project_path(
                serializer.validated_data.get("filesystem_path") or f"/workspace/{serializer.validated_data['slug']}"
            )
        except ValueError as exc:
            raise ApiValidationError({"filesystem_path": str(exc)}) from exc
        if workspace.projects.filter(filesystem_path=filesystem_path).exists():
            raise ApiValidationError({"filesystem_path": "This filesystem path is already a project."})

        shared = SandboxBootstrapService.ensure_workspace_sandbox(workspace)

        values = {
            "user": self.request.user,
            "workspace": workspace,
            "filesystem_path": filesystem_path,
            "sandbox_gpu": "CPU",
            "sandbox_cpu": shared.sandbox_cpu,
            "sandbox_memory": shared.sandbox_memory,
            "idle_timeout_seconds": shared.idle_timeout_seconds,
            "sandbox_object_id": shared.sandbox_object_id,
            "terminal_url": shared.terminal_url,
            "terminal_token": shared.terminal_token,
        }
        project = Sandbox(**{**serializer.validated_data, **values})
        try:
            initialize_project_repository(project)
        except GitInitializationError as exc:
            logger.exception("Failed to initialize project repository")
            raise APIException(str(exc)) from exc
        values.update(
            sandbox_object_id=project.sandbox_object_id,
            terminal_url=project.terminal_url,
            terminal_token=project.terminal_token,
        )
        with transaction.atomic():
            Workspace.objects.select_for_update().get(pk=workspace.pk)
            if workspace.projects.filter(filesystem_path=filesystem_path).exists():
                raise ApiValidationError({"filesystem_path": "This filesystem path is already a project."})
            created_project = serializer.save(**values)

        _init_project_suggestions_on_create(created_project)


class SandboxDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = SandboxSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if _is_admin(user):
            return Sandbox.objects.all()
        return _accessible_projects(user)

    def get_object(self):
        from django.http import Http404
        import uuid as _uuid

        queryset = self.filter_queryset(self.get_queryset())
        lookup_val = self.kwargs.get("lookup") or self.kwargs.get("uuid")
        try:
            parsed_uuid = _uuid.UUID(str(lookup_val))
            obj = queryset.filter(uuid=parsed_uuid).first()
        except (ValueError, TypeError, AttributeError):
            obj = queryset.filter(slug=lookup_val).first()

        if not obj:
            raise Http404("Sandbox not found")
        self.check_object_permissions(self.request, obj)
        return obj

    def perform_update(self, serializer):
        project = serializer.save()
        if "conversation" in serializer.validated_data and project.conversation_id:
            project.conversations.add(project.conversation_id)
        remove_conversation = self.request.data.get("remove_conversation")
        if remove_conversation:
            project.conversations.remove(remove_conversation)
            if str(project.conversation_id or "") == str(remove_conversation):
                project.conversation = project.conversations.first()
                project.save(update_fields=["conversation", "updated_at"])
        resource_updates = {}
        if "sandbox_cpu" in serializer.validated_data:
            resource_updates["sandbox_cpu"] = max(0.5, min(8.0, float(project.sandbox_cpu)))
        if "sandbox_memory" in serializer.validated_data:
            resource_updates["sandbox_memory"] = max(512, min(16384, int(project.sandbox_memory)))
        if resource_updates:
            # Compute belongs to the shared user sandbox, not to a project.
            from sandbox.services.sandbox_session import get_sandbox_manager

            get_sandbox_manager().close_session_immediately(project)
            projects = Sandbox.objects.filter(workspace=project.workspace) if project.workspace_id else Sandbox.objects.filter(user=project.user)
            projects.update(
                **resource_updates,
                sandbox_object_id="",
                terminal_url="",
                terminal_token="",
            )
            for field, value in resource_updates.items():
                setattr(project, field, value)
            project.sandbox_object_id = ""
            project.terminal_url = ""
            project.terminal_token = ""


# ─── Sandbox Files ──────────────────────────────────────────────────────────────

class SandboxFileListCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()

        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox_manager = get_sandbox_manager()

        # Refresh from the selected workspace filesystem. VM disk access starts
        # a stopped VM so terminal-created files appear in the same tree.
        try:
            sandbox_manager._sync_file_tree_to_db(project)
        except Exception as e:
            logger.warning("Failed to sync file tree for sandbox %s: %s", project.uuid, e)
            return Response({"error": "Workspace storage is unavailable. Please retry."}, status=503)

        # Return files from cache
        from utils.cache import get_sandbox_files
        res = get_sandbox_files(str(project.uuid)) or []

        parent = request.query_params.get("parent")
        import os
        if parent:
            parent_path = parent.rstrip("/")
            filtered = []
            for f in res:
                path_str = f.get("path", "")
                if os.path.dirname(path_str) == parent_path:
                    filtered.append(f)
            res = filtered

        # Without a `parent` param, the full tree is served so the frontend can
        # refresh atomically (expanded folders keep their contents). Folder
        # expansion still uses `?parent=` for lazy loading.
        return Response(res)

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            if project and getattr(project, "workspace", None):
                try:
                    vm = _resolve_and_wake_vm(project.workspace, request.user, vm_uuid=request.data.get("vm_uuid"), timeout=30)
                    if vm:
                        _bind_workspace_runtime_vm(project, vm)
                except (RuntimeError, TimeoutError) as exc:
                    return Response({"error": str(exc)}, status=503)
            if not _has_running_vm(project):
                return _no_vm_response()
        path = request.data.get("path")
        is_directory = request.data.get("is_directory", False)

        if not path:
            return Response({"error": "Path is required"}, status=400)

        if not path.startswith("/workspace/"):
            path = f"/workspace/{path.lstrip('/')}"

        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox_manager = get_sandbox_manager()

        try:
            if is_directory:
                from sandbox.services.volume_tools import mkdir_via_daemon
                resp = mkdir_via_daemon(project, path)
                if resp.get("error"):
                    return Response({"error": resp["error"]}, status=500)
            else:
                from sandbox.services.volume_tools import write_file
                write_file(project, path, b"")

            # Sync files so frontend is updated
            sandbox_manager._sync_file_tree_to_db(project)
        except Exception as exc:
            logger.exception("Failed to create file/folder in workspace")
            return Response({"error": f"Failed to create file/folder: {exc}"}, status=500)

        return Response({"success": True}, status=201)


class SandboxFileDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def delete(self, request, sandbox_uuid, file_id):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()
        import base64
        try:
            file_path = base64.b64decode(file_id, altchars=b'-_', validate=True).decode('utf-8')
        except Exception:
            return Response({"error": "Invalid file ID"}, status=400)

        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox_manager = get_sandbox_manager()

        try:
            from sandbox.services.volume_tools import remove_file
            remove_file(project, file_path)
            # Sync files so frontend is updated
            sandbox_manager._sync_file_tree_to_db(project)
        except Exception as exc:
            logger.exception("Failed to delete file from workspace")
            return Response({"error": f"Failed to delete file: {exc}"}, status=500)

        return Response(status=204)

    def patch(self, request, sandbox_uuid, file_id):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()
        import base64
        try:
            file_path = base64.b64decode(file_id).decode('utf-8')
        except Exception:
            return Response({"error": "Invalid file ID"}, status=400)

        new_path = request.data.get("new_path")
        if not new_path:
            return Response({"error": "new_path is required"}, status=400)
        if not new_path.startswith("/workspace/"):
            new_path = f"/workspace/{new_path.lstrip('/')}"

        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox_manager = get_sandbox_manager()

        try:
            from sandbox.services.volume_tools import rename_file
            rename_file(project, file_path, new_path)
            # Sync files so frontend is updated
            sandbox_manager._sync_file_tree_to_db(project)
        except Exception as exc:
            logger.exception("Failed to rename file in workspace")
            return Response({"error": f"Failed to rename file: {exc}"}, status=500)

        return Response({"success": True})


from rest_framework.parsers import FormParser, MultiPartParser


class SandboxFileUploadView(APIView):
    """Upload a file to the selected workspace filesystem."""
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = (MultiPartParser, FormParser)
    throttle_scope = 'file_upload'

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            if project and getattr(project, "workspace", None):
                try:
                    vm = _resolve_and_wake_vm(project.workspace, request.user, vm_uuid=request.data.get("vm_uuid"), timeout=30)
                    if vm:
                        _bind_workspace_runtime_vm(project, vm)
                except (RuntimeError, TimeoutError) as exc:
                    return Response({"error": str(exc)}, status=503)
            if not _has_running_vm(project):
                return _no_vm_response()

        file_obj = request.FILES.get('file')
        if not file_obj:
            return Response({"error": "No file uploaded"}, status=400)

        filename = request.data.get("filename") or file_obj.name
        if not filename or not isinstance(filename, str) or '\x00' in filename or '\\' in filename:
            return Response({"error": "Invalid file name"}, status=400)

        # 100 MB limit guard
        if getattr(file_obj, 'size', 0) > 100 * 1024 * 1024:
            return Response({"error": "Uploaded file exceeds maximum limit of 100 MB."}, status=400)

        # Determine destination path in sandbox
        # Ensure it's inside /workspace
        if not filename.startswith("/workspace/"):
            filename = f"/workspace/{filename.lstrip('/')}"

        clean_parts = [p for p in filename.split('/') if p]
        if any(part in ('.', '..') for part in clean_parts):
            return Response({"error": "Path traversal in file name is not allowed"}, status=400)

        content_bytes = file_obj.read()

        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox_manager = get_sandbox_manager()

        try:
            from sandbox.services.volume_tools import shared_workspace_project, write_file
            is_shared_upload = filename == "/workspace/.uploads" or filename.startswith("/workspace/.uploads/")
            target_project = shared_workspace_project(project) if is_shared_upload else project
            write_file(target_project, filename, content_bytes)
            # Sync files so frontend is updated
            sandbox_manager._sync_file_tree_to_db(project)
        except Exception as exc:
            logger.exception("Failed to write file to workspace")
            return Response({"error": f"Could not save file: {exc}"}, status=503)

        import base64
        file_id = base64.b64encode(filename.encode('utf-8')).decode('utf-8')
        return Response({
            "uuid": file_id,
            "path": filename,
        }, status=201)


def _github_fork_parent(token: str, owner: str, repo: str) -> str | None:
    """Return the parent clone URL when the repository is a GitHub fork."""
    if not token:
        return None
    import requests

    try:
        response = requests.get(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
            timeout=10,
            allow_redirects=False,
        )
        if response.status_code != 200:
            return None
        data = response.json()
        if not data.get("fork"):
            return None
        parent = data.get("parent") or {}
        return parent.get("clone_url")
    except Exception:
        return None


def _github_git_identity(user, social_auth) -> tuple[str, str]:
    extra = (social_auth.extra_data or {}) if social_auth else {}
    name = extra.get("login") or user.get_full_name() or user.username
    email = extra.get("email") or user.email or f"{name}@users.noreply.github.com"
    return name, email


class SandboxGitCloneView(APIView):
    """Clone a GitHub repository and register its folder as a project."""
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'sandbox_clone'

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        repo_url = request.data.get("repo_url")
        if not isinstance(repo_url, str) or not repo_url.strip():
            return Response({"error": "repo_url is required"}, status=400)

        # Basic validation / normalization of repo_url
        repo_url = repo_url.strip()
        if not (repo_url.startswith("https://github.com/") or repo_url.startswith("git@github.com:") or repo_url.startswith("http://") or repo_url.startswith("https://") or repo_url.startswith("git://")):
            if "/" in repo_url and len(repo_url.split("/")) == 2:
                repo_url = f"https://github.com/{repo_url}.git"
            else:
                return Response({"error": "Invalid GitHub repository URL or format"}, status=400)

        # Validate the destination before starting the workspace runtime.
        import re
        repo_name = repo_url.rstrip("/").split("/")[-1].removesuffix(".git")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", repo_name) or repo_name in {".", "..", ".git"}:
            return Response({"error": "Invalid repository name"}, status=400)
        destination = request.data.get("destination_path")
        if destination is not None:
            try:
                if not isinstance(destination, str) or re.search(r"[\\\x00-\x1f]", destination):
                    raise ValueError("Choose a folder inside /workspace")
                target_path = _normalize_project_path(destination)
                if any(part.lower() == ".git" for part in PurePosixPath(target_path).parts):
                    raise ValueError("The clone destination cannot be inside .git")
            except ValueError as exc:
                return Response({"error": str(exc)}, status=400)
        else:
            from sandbox.services.volume_tools import _runtime_path
            target_path = _runtime_path(project, f"/workspace/{repo_name}")

        vm = None
        if project and getattr(project, "workspace", None):
            try:
                vm = _resolve_and_wake_vm(
                    project.workspace,
                    request.user,
                    vm_uuid=request.data.get("vm_uuid"),
                )
            except (RuntimeError, TimeoutError) as exc:
                return Response({"error": str(exc)}, status=503)
        if not _has_running_vm(project):
            return _no_vm_response()
        if vm:
            from sandbox.services.sandbox_service import SandboxBootstrapService
            _bind_workspace_runtime_vm(project, vm)
            shared = SandboxBootstrapService.ensure_workspace_sandbox(project.workspace)
            if shared.pk != project.pk:
                _bind_workspace_runtime_vm(shared, vm)

        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox_manager = get_sandbox_manager()
        try:
            sandbox = sandbox_manager.get_or_create(project)
            origin_url = repo_url
            # Inject GitHub OAuth token if the user has connected their GitHub account
            from social_django.models import UserSocialAuth

            social_auth = get_github_connection(request.user, request.query_params.get("account"))
            access_token = ""
            if social_auth and social_auth.extra_data and "access_token" in social_auth.extra_data:
                access_token = social_auth.extra_data["access_token"]
                # Match git@github.com:owner/repo.git or https://github.com/owner/repo.git (and http/https variants)
                github_match = re.match(r'(?:git@github\.com:|https?://github\.com/)([^/]+)/([^/]+?)(?:\.git)?/?$', repo_url)
                if github_match:
                    owner, repo = github_match.groups()
                    repo_url = f"https://x-access-token:{access_token}@github.com/{owner}/{repo}.git"

            cmd = repository_clone_command(repo_url, target_path, origin_url)
            if not uses_remote_runtime():
                # The minimal local Docker image needs git before its first clone.
                cmd = "(command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y git ca-certificates)) && " + cmd

            from django.http import StreamingHttpResponse

            def stream_output():
                try:
                    # Merge git's stderr progress into the streamed stdout.
                    process = sandbox.exec("bash", "-lc", f"({cmd}) 2>&1", timeout=120)

                    from sandbox.services.process_stream import process_output
                    token = (social_auth.extra_data or {}).get("access_token", "") if social_auth else ""
                    diagnostics = ""
                    for text in process_output(process.stdout, token):
                        diagnostics = (diagnostics + text.lower())[-4000:]
                        yield text

                    process.wait()

                    sandbox_manager.update_activity(str(project.uuid))

                    # Sync before reporting completion so refreshes see the files.
                    sandbox_manager._sync_file_tree_to_db(project)
                    if process.returncode != 0:
                        message = f"Clone failed with exit code {process.returncode}."
                        if "github.com" in origin_url and any(error in diagnostics for error in ("repository not found", "authentication failed", "could not read username", "invalid username", "permission denied")):
                            message += " Connect or reconnect GitHub with private repository access and use an account that can read this repository."
                        yield f"\n[Error] {message}\n"
                    else:
                        if access_token:
                            try:
                                user_name, user_email = _github_git_identity(request.user, social_auth)
                                upstream_url = None
                                github_match = re.match(
                                    r'(?:git@github\.com:|https?://github\.com/)([^/]+)/([^/]+?)(?:\.git)?/?$',
                                    origin_url,
                                )
                                if github_match:
                                    owner, repo = github_match.groups()
                                    upstream_url = _github_fork_parent(access_token, owner, repo)
                                configure_github_git(
                                    sandbox,
                                    access_token,
                                    user_name=user_name,
                                    user_email=user_email,
                                    target_path=target_path,
                                    upstream_url=upstream_url,
                                )
                            except Exception:
                                logger.warning("Could not configure GitHub credentials for project %s", project.uuid)
                        try:
                            _register_cloned_project(request.user, project, target_path)
                        except Exception:
                            logger.exception("Could not register cloned project at %s", target_path)
                            yield f"\n[Error] Repository was cloned into {target_path}, but its project could not be created. Add this folder as an existing project.\n"
                            return
                        yield f"\n[Success] Repository cloned successfully into {target_path}!\n"
                except Exception:
                    logger.warning("Repository clone stream failed for project %s", project.uuid)
                    yield "\n[Error] Repository clone failed. Please try again.\n"

            response = StreamingHttpResponse(stream_output(), content_type="text/plain")
            response["X-Accel-Buffering"] = "no"
            response["Cache-Control"] = "no-cache, no-transform"
            return response

        except Exception as exc:
            logger.exception("Failed to clone repository in sandbox")
            if _handle_dead_sandbox(sandbox_uuid, exc):
                return Response({"error": "Sandbox is no longer running. Please restart it."}, status=503)
            return Response({"error": f"Failed to clone repository: {exc}"}, status=500)


class SandboxGitCloneCommandView(APIView):
    """Generate the exact git clone command with OAuth token injected if applicable."""
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'sandbox_clone'

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        repo_url = request.data.get("repo_url")
        if not repo_url:
            return Response({"error": "repo_url is required"}, status=400)

        repo_url = repo_url.strip()
        if not (repo_url.startswith("https://github.com/") or repo_url.startswith("git@github.com:") or repo_url.startswith("http://") or repo_url.startswith("https://") or repo_url.startswith("git://")):
            if "/" in repo_url and len(repo_url.split("/")) == 2:
                repo_url = f"https://github.com/{repo_url}.git"
            else:
                return Response({"error": "Invalid GitHub repository URL or format"}, status=400)

        # Inject GitHub OAuth token if the user has connected their GitHub account
        import re

        from social_django.models import UserSocialAuth

        social_auth = get_github_connection(request.user, request.query_params.get("account"))
        token = ""
        if social_auth and social_auth.extra_data and "access_token" in social_auth.extra_data:
            token = social_auth.extra_data["access_token"]

        # Extract target folder name and validate
        repo_name = repo_url.rstrip("/").split("/")[-1].removesuffix(".git")
        if "@" in repo_name:
            repo_name = repo_name.split("@")[-1]

        if not re.fullmatch(r"[A-Za-z0-9_.-]+", repo_name) or repo_name in {".", "..", ".git"}:
            return Response({"error": "Invalid repository name"}, status=400)

        target_path = f"/workspace/{repo_name}"

        # Build clean clone URL (no token in URL)
        clean_url = repo_url
        github_match = re.match(r'(?:git@github\.com:|https?://github\.com/)([^/]+)/([^/.]+?)(?:\.git)?/?$', repo_url)
        if github_match:
            owner, repo = github_match.groups()
            clean_url = f"https://github.com/{owner}/{repo}.git"

        # Configure credentials and fork metadata so the agent can push directly.
        if token:
            from sandbox.services.sandbox_session import get_sandbox_manager
            sandbox_manager = get_sandbox_manager()
            sandbox = sandbox_manager.get_or_create(project)

            try:
                user_name, user_email = _github_git_identity(request.user, social_auth)
                upstream_url = None
                if github_match:
                    upstream_url = _github_fork_parent(token, owner, repo)
                configure_github_git(
                    sandbox,
                    token,
                    user_name=user_name,
                    user_email=user_email,
                    target_path=target_path,
                    upstream_url=upstream_url,
                )
            except Exception as e:
                logger.error("Failed to configure git credentials in sandbox: %s", e)
                return Response({"error": "Failed to configure container credentials"}, status=500)

        command = (
            f"({repository_clone_command(clean_url, target_path, clean_url)}) && "
            f"(echo -e '\\n\\033[32;1m✓ Repository cloned successfully. Closing terminal in 5 seconds...\\033[0m' && sleep 5) || "
            f"(echo -e '\\n\\033[31;1m✗ Clone failed. Closing terminal in 5 seconds...\\033[0m' && sleep 5)"
        )

        return Response({"command": command, "target_path": target_path})


# ─── File Content (read / write from workspace storage) ────────────────────────

class SandboxImagePreviewView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()
        from chat.tools.display_image import handle_display_image
        path = request.query_params.get("path", "")
        if not path.startswith("/workspace/"):
            return Response({"error": "Image files must be inside /workspace."}, status=400)
        result = handle_display_image(request.user, {"source": path, "_sandbox_uuid": str(project.uuid)})
        return Response(result, status=400 if "error" in result else 200)


class SandboxFileContentView(APIView):
    """Read and write the selected workspace's storage for browser editing."""

    permission_classes = [permissions.IsAuthenticated]
    MAX_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB guard

    def get(self, request, sandbox_uuid, file_id):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()

        import base64
        try:
            file_path = base64.urlsafe_b64decode(file_id).decode('utf-8')
        except Exception:
            return Response({"error": "Invalid file ID"}, status=400)

        from sandbox.services.volume_tools import read_file

        try:
            content = read_file(project, file_path)
        except ValueError as exc:
            return Response({'error': str(exc)}, status=400)
        except Exception:
            logger.exception('Could not read workspace storage')
            return Response({'error': 'Workspace storage is unavailable. Please retry.'}, status=503)
        if content is None:
            return Response({"error": "File not found in workspace"}, status=404)
        if len(content) > self.MAX_SIZE_BYTES:
            return Response({"error": "File too large. Max 5 MB."}, status=413)

        try:
            text = content.decode("utf-8")
            is_binary = False
        except UnicodeDecodeError:
            text = base64.b64encode(content).decode()
            is_binary = True

        return Response({
            "uuid": file_id,
            "path": file_path,
            "content": text,
            "is_binary": is_binary,
        })

    def put(self, request, sandbox_uuid, file_id):
        """Save edited file content directly to the workspace volume."""
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()

        import base64
        try:
            file_path = base64.b64decode(file_id).decode('utf-8')
        except Exception:
            return Response({"error": "Invalid file ID"}, status=400)

        content_str = request.data.get("content")
        if content_str is None:
            return Response({"error": "content field required"}, status=400)

        is_base64 = request.data.get("is_base64", False)
        if is_base64:
            try:
                content_bytes = base64.b64decode(content_str)
            except Exception:
                return Response({"error": "Invalid base64 content"}, status=400)
        else:
            content_bytes = content_str.encode("utf-8")

        if len(content_bytes) > self.MAX_SIZE_BYTES:
            return Response({"error": "File too large. Max 5 MB."}, status=413)

        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox_manager = get_sandbox_manager()

        try:
            from sandbox.services.volume_tools import write_file
            write_file(project, file_path, content_bytes)
            # Sync files so frontend is updated
            sandbox_manager._sync_file_tree_to_db(project)
        except Exception as exc:
            logger.exception("Failed to write file to workspace")
            return Response({"error": f"Could not save file: {exc}"}, status=503)

        return Response({
            "uuid": file_id,
            "path": file_path,
        })


# ─── Sandbox Events ─────────────────────────────────────────────────────────────

class SandboxEventsView(generics.ListAPIView):
    serializer_class = SandboxEventSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        sandbox = _get_accessible_project(self.request.user, self.kwargs["sandbox_uuid"])
        return SandboxEvent.objects.filter(sandbox=sandbox).order_by("-created_at")[:100]


# ─── Sandbox Agent Tools (list / pick / create) ─────────────────────────────────

class SandboxAgentToolsView(APIView):
    """
    - GET  /sandbox-tools/list/  → user's sandboxes (with tier + idle limits)
    - POST /sandbox-tools/list/  → {"action":"pick"|"create", ...}
    """

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        tier = _resolve_user_tier(request.user)
        workspace_uuid = request.query_params.get("workspace_uuid")
        from sandbox.services.sandbox_service import SandboxBootstrapService
        if workspace_uuid:
            workspace = get_object_or_404(_accessible_workspaces(request.user), uuid=workspace_uuid)
        else:
            workspace = SandboxBootstrapService.ensure_personal_workspace(request.user)
        filesystem = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
        items = (
            _accessible_projects(request.user).filter(workspace=workspace)
            .exclude(filesystem_path="/workspace")
            .prefetch_related("conversations").order_by("-updated_at")
        )

        idle_limits = getattr(settings, "SANDBOX_IDLE_TIMEOUT_LIMITS", {}).get(
            tier, {"cpu": 300}
        )
        return Response({
            "tier": tier,
            "sandboxes": SandboxSerializer(items, many=True).data,
            "workspace_sandbox": SandboxSerializer(filesystem).data,
            "idle_timeout_limits": idle_limits,
            "idle_timeout_default": getattr(settings, "SANDBOX_IDLE_TIMEOUT_DEFAULT", 10),
            "idle_timeout_min": getattr(settings, "SANDBOX_IDLE_TIMEOUT_MIN", 5),
        })

    def post(self, request):
        from sandbox.services.sandbox_service import SandboxBootstrapService

        data = request.data
        action = (data.get("action") or "").lower()

        if action == "pick":
            sandbox_uuid = data.get("sandbox_uuid")
            if sandbox_uuid:
                sandbox = _get_accessible_project(request.user, sandbox_uuid)
                if data.get("workspace_uuid") and str(sandbox.workspace_id) != str(data["workspace_uuid"]):
                    return Response({"error": "Project does not belong to the selected workspace."}, status=400)
            else:
                projects = _accessible_projects(request.user)
                workspace_uuid = data.get("workspace_uuid")
                if workspace_uuid:
                    projects = projects.filter(workspace_id=workspace_uuid)
                sandbox = projects.exclude(filesystem_path="/workspace").order_by("-updated_at").first()
                if not sandbox:
                    from sandbox.services.sandbox_service import SandboxBootstrapService
                    if workspace_uuid:
                        workspace = get_object_or_404(_accessible_workspaces(request.user), uuid=workspace_uuid)
                        sandbox = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
                    else:
                        sandbox = SandboxBootstrapService.ensure_personal_filesystem(request.user)
            sandbox.sandbox_last_active_at = timezone.now()
            sandbox.save(update_fields=["sandbox_last_active_at", "updated_at"])
            return Response(SandboxSerializer(sandbox).data)

        if action == "create":
            workspace_uuid = data.get("workspace_uuid")
            if workspace_uuid:
                workspace = get_object_or_404(_accessible_workspaces(request.user), uuid=workspace_uuid)
            else:
                from sandbox.services.sandbox_service import SandboxBootstrapService
                workspace = SandboxBootstrapService.ensure_personal_workspace(request.user)
            try:
                filesystem_path = _normalize_project_path(data.get("filesystem_path", ""))
            except ValueError as exc:
                return Response({"error": str(exc)}, status=400)
            if Sandbox.objects.filter(workspace=workspace, filesystem_path=filesystem_path).exists():
                return Response({"error": "This filesystem path is already a project."}, status=400)

            # Runtime resources are workspace-wide. A project never allocates its own
            # sandbox and therefore inherits the existing shared configuration.
            shared = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
            sandbox_cpu = float(shared.sandbox_cpu) if shared else 2.0
            sandbox_memory = int(shared.sandbox_memory) if shared else 4096
            idle_timeout = int(shared.idle_timeout_seconds) if shared else 300

            display_name = (data.get("display_name") or "").strip()
            if not display_name:
                display_name = PurePosixPath(filesystem_path).name

            slug_base = slugify(data.get("slug") or display_name)[:50] or "project"
            candidate = slug_base
            for index in range(50):
                if not Sandbox.objects.filter(workspace=workspace, slug=candidate).exists():
                    break
                candidate = f"{slug_base}-{index}"
            else:
                return Response({"error": "Could not allocate a unique slug."}, status=400)

            sandbox = Sandbox(
                user=request.user,
                workspace=workspace,
                slug=candidate,
                display_name=display_name,
                description=data.get("description", ""),
                filesystem_path=filesystem_path,
                sandbox_gpu="CPU",
                sandbox_cpu=sandbox_cpu,
                sandbox_memory=sandbox_memory,
                idle_timeout_seconds=idle_timeout,
                r2_workspace_prefix=f"sandboxes/workspace-{workspace.storage_key}/{filesystem_path.removeprefix('/workspace/').strip('/')}/",
                sandbox_object_id=shared.sandbox_object_id if shared else "",
                terminal_url=shared.terminal_url if shared else "",
                terminal_token=shared.terminal_token if shared else "",
                sandbox_last_active_at=timezone.now(),
                is_favorite=False,
            )
            try:
                source = data.get("source")
                if source in ("new", "existing"):
                    from sandbox.services.repository_browser import read_repository
                    read_repository(shared, "initialize", filesystem_path, data={"source": source})
                    if shared:
                        shared.refresh_from_db()
                        sandbox.sandbox_object_id = shared.sandbox_object_id
                        sandbox.terminal_url = shared.terminal_url
                        sandbox.terminal_token = shared.terminal_token
                elif source is not None:
                    return Response({"error": "Choose a valid project source."}, status=400)
                else:
                    initialize_project_repository(sandbox)
            except ValueError as exc:
                return Response({"error": str(exc)}, status=400)
            except GitInitializationError as exc:
                logger.exception("Failed to initialize project repository")
                return Response({"error": str(exc)}, status=500)
            except RuntimeError as exc:
                if "virtual machine" in str(exc).lower():
                    return _no_vm_response()
                logger.exception("Failed to initialize project runtime")
                return Response({"error": str(exc)}, status=503)
            with transaction.atomic():
                Workspace.objects.select_for_update().get(pk=workspace.pk)
                if Sandbox.objects.filter(workspace=workspace, filesystem_path=filesystem_path).exists():
                    return Response({"error": "This filesystem path is already a project."}, status=400)
                sandbox.save()

            _init_project_suggestions_on_create(sandbox)
            return Response(SandboxSerializer(sandbox).data, status=201)

        return Response({"error": "Unknown action. Use 'pick' or 'create'."}, status=400)



def get_user_region(request, timezone_str=None) -> str | None:
    # 1. Check timezone string passed from frontend
    if timezone_str:
        timezone_str = timezone_str.lower()
        if "america" in timezone_str or "us/" in timezone_str or "canada/" in timezone_str:
            return "us-east"

    # 2. Check Cloudflare country header
    cf_country = request.META.get('HTTP_CF_IPCOUNTRY')
    if cf_country:
        cf_country = cf_country.upper()
        # North and South American countries
        us_countries = {'US', 'CA', 'MX', 'BR', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC'}
        if cf_country in us_countries:
            return "us-east"

    return None


class SandboxStartView(APIView):
    """
    Spawns or resumes the Sandbox and returns connection details.
    POST /sandbox/sandboxes/<uuid>/start/ -> Sandbox object
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, sandbox_uuid):
        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox = _get_accessible_project(request.user, sandbox_uuid)
        manager = get_sandbox_manager()

        timezone_str = request.data.get("timezone")
        region = get_user_region(request, timezone_str)

        manager.get_or_create(sandbox, region=region)
        sandbox.refresh_from_db()

        return Response(SandboxSerializer(sandbox).data)


class SandboxPingView(APIView):
    """
    Pings the sandbox to prevent idle timeout.
    POST /sandbox/sandboxes/<uuid>/ping/
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, sandbox_uuid):
        from sandbox.services.sandbox_session import get_sandbox_manager
        sandbox = _get_accessible_project(request.user, sandbox_uuid)
        manager = get_sandbox_manager()
        status = manager.update_activity(str(sandbox.uuid))
        if not isinstance(status, dict):
            status = {}
        return Response({
            "success": True,
            "pong": True,
            "shutdown_at": status.get("shutdown_at"),
            "remaining_seconds": status.get("remaining_seconds", 0),
        })


class SandboxGithubReposView(APIView):
    """List public and private repositories accessible to the connected account."""
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid=None):
        import requests
        from social_django.models import UserSocialAuth

        if sandbox_uuid is not None:
            _get_accessible_project(request.user, sandbox_uuid)
        try:
            page = int(request.query_params.get("page", 1))
            if page < 1 or page > 100:
                raise ValueError
        except (TypeError, ValueError):
            return Response({"error": "Invalid repository page."}, status=400)
        connection = get_github_connection(request.user, request.query_params.get("account"))
        token = (connection.extra_data or {}).get("access_token") if connection else None
        if not token:
            from utils.cache import get_cache
            last_error = get_cache(f"github-connect-error:{request.user.pk}")
            return Response({"connected": False, "reason": "not_connected", "repos": [], "error": last_error})
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
        try:
            response = requests.get("https://api.github.com/user/repos", headers=headers, params={"per_page": 30, "page": page, "sort": "updated", "visibility": "all", "affiliation": "owner,collaborator,organization_member"}, timeout=15, allow_redirects=False)
            if response.status_code == 401:
                return Response({"connected": False, "reason": "expired", "repos": []})
            if response.status_code != 200:
                message = "Repositories could not be loaded from GitHub. Try again."
                if response.headers.get("X-GitHub-SSO"):
                    message = "Authorize this GitHub connection for your organization’s SSO, then reconnect."
                elif response.status_code in (403, 429):
                    message = "GitHub denied access or its request limit was reached. Reconnect or try again later."
                return Response({"error": message}, status=502)
            repos = [{"name": r.get("name"), "full_name": r.get("full_name"), "clone_url": r.get("clone_url"), "private": bool(r.get("private")), "description": r.get("description")} for r in response.json()]
            scope = response.headers.get("X-OAuth-Scopes", (connection.extra_data or {}).get("scope"))
            private_access = None if scope is None else "repo" in str(scope).replace(",", " ").split()
            if any(repo["private"] for repo in repos):
                private_access = True
            return Response({"connected": True, "username": (connection.extra_data or {}).get("login"), "can_access_private": private_access, "repos": repos, "has_next": page < 100 and "next" in response.links, "page": page})
        except (requests.RequestException, ValueError, TypeError, AttributeError):
            return Response({"error": "Repositories could not be loaded from GitHub. Try again."}, status=502)

    def delete(self, request, sandbox_uuid):
        from social_django.models import UserSocialAuth
        _get_accessible_project(request.user, sandbox_uuid)
        connection = get_github_connection(request.user, request.query_params.get("account"))
        if connection:
            connection.delete()
        return Response({"success": True})


# ─── HuggingFace Model Catalog (Import From HF) ──────────────────────────────

class ModelRuntimeCatalogView(APIView):
    """Global model catalog + Import From HuggingFace.

    - GET  /sandbox/models/  → public (active) + downloading models
    - POST /sandbox/models/  → {"repo_id": "...", "display_name": "..."} starts an import
    """

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        runner = request.query_params.get("runner")
        user = request.user

        status_filter = Q(status__in=[Model.STATUS_ACTIVE, Model.STATUS_DOWNLOADING, Model.STATUS_ERROR])
        if user and user.is_authenticated:
            visibility_filter = Q(is_public=True) | Q(author=user)
        else:
            visibility_filter = Q(is_public=True)

        filters = status_filter & visibility_filter
        if runner:
            filters &= Q(runner=runner)
        else:
            filters &= (
                Q(runner__in=[getattr(Model, "RUNNER_SD_CPP", "stable_diffusion_cpp"), "stable_diffusion_cpp", "trt"])
                | Q(model_type="image")
            )

        models_qs = Model.objects.filter(
            filters
        ).select_related("llm_config").order_by("-created_at")

        return Response({
            "count": models_qs.count(),
            "results": ModelSerializer(models_qs, many=True).data,
        })

    def post(self, request):
        return Response(
            {"error": "Configure external or local OpenAI-compatible models via Workspace Provider Keys or Custom Models."},
            status=status.HTTP_501_NOT_IMPLEMENTED,
        )


class ModelRuntimeDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, slug):
        model_obj = Model.objects.filter(
            Q(name=slug) | Q(storage_path=f"hf/{slug}") | Q(storage_path=slug)
        ).select_related("llm_config").first()
        if not model_obj:
            return Response({"detail": "Not found."}, status=404)
        return Response(ModelSerializer(model_obj).data)


class SandboxGitStatusView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        from .services.git_service import SandboxGitService
        status_data = SandboxGitService.get_status(project)
        return Response(status_data)


class SandboxGitDiffView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        from .services.git_service import SandboxGitService
        base_commit = request.query_params.get("base_commit")
        diff_data = SandboxGitService.get_diff(project, base_commit=base_commit)
        return Response(diff_data)


class SandboxGitUndoView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        from .services.git_service import SandboxGitService
        target_commit = request.data.get("target_commit")
        result = SandboxGitService.undo_changes(project, target_commit=target_commit)
        if not result.get("success"):
            return Response(result, status=status.HTTP_400_BAD_REQUEST)
        return Response(result)


class SandboxGitInitView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        from .services.git_service import SandboxGitService
        success = SandboxGitService.ensure_git_repo(project)
        return Response({"success": success})


class TerminalTicketThrottle(UserRateThrottle):
    scope = "terminal_ticket"
    rate = "60/minute"


class SandboxTerminalTicketView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [TerminalTicketThrottle]

    def post(self, request, sandbox_uuid):
        from core.extensions import registry as ext_registry
        from .ws_security import can_access_sandbox, issue_ticket, TICKET_TTL

        project = _get_accessible_project(request.user, sandbox_uuid)
        if not can_access_sandbox(request.user, project):
            return Response({"error": "Workspace access required."}, status=403)
        if project.workspace_id:
            ext_registry.quota.ensure_balance(project.workspace, user=request.user)
        payload = {"ticket": issue_ticket(request.user, project.uuid, request.auth), "expires_in": TICKET_TTL}
        if ext_registry.runtime.create_direct_terminal is not None:
            direct = ext_registry.runtime.create_direct_terminal(request, project)
            if direct:
                payload.update(direct)
        response = Response(payload)
        response["Cache-Control"] = "no-store"
        return response


def _get_fallback_suggestions(project, file_paths: list[str]) -> list[dict]:
    name = project.display_name or project.slug or "project"
    lower_paths = [p.lower() for p in file_paths]
    file_names = [PurePosixPath(p).name.lower() for p in file_paths]

    is_node = any(fn == "package.json" for fn in file_names) or any("node_modules" in p or "frontend" in p for p in lower_paths)
    is_python = any(fn in ("requirements.txt", "pyproject.toml", "pipfile", "manage.py", "main.py") for fn in file_names)
    has_docker = any("dockerfile" in fn or "docker-compose" in fn for fn in file_names)
    has_tests = any("test" in fn or "spec" in fn for fn in file_names) or any("/tests/" in p or "/__tests__/" in p for p in lower_paths)

    items = []
    if is_node:
        items.append({
            "label": "Start dev server",
            "prompt": f"Start the development server for {name} and verify port preview: ",
            "category": "run",
        })
    elif is_python:
        items.append({
            "label": "Run API server",
            "prompt": f"Set up the virtual environment and run the server for {name}: ",
            "category": "run",
        })
    else:
        items.append({
            "label": "Run in terminal",
            "prompt": f"Inspect the project environment and run the main entrypoint for {name}: ",
            "category": "run",
        })

    items.append({
        "label": "Explore architecture",
        "prompt": f"Analyze the directory structure, dependencies, and entrypoints of {name}: ",
        "category": "arch",
    })

    if has_tests:
        items.append({
            "label": "Run test suite",
            "prompt": f"Run automated tests for {name} and report any failures: ",
            "category": "test",
        })
    else:
        items.append({
            "label": "Debug & check logs",
            "prompt": f"Inspect error logs, diagnose issues, and apply fixes for {name}: ",
            "category": "debug",
        })

    if has_docker:
        items.append({
            "label": "Docker services",
            "prompt": f"Check docker configuration and container services for {name}: ",
            "category": "feature",
        })
    else:
        items.append({
            "label": "Add feature",
            "prompt": f"Plan and scaffold a new feature for {name}: ",
            "category": "feature",
        })

    items.append({
        "label": "Git diff & PR",
        "prompt": f"Review uncommitted changes in {name}, run tests, and prepare a PR: ",
        "category": "git",
    })
    return items


def _get_project_readme_content(project, request_readme=None) -> str:
    if request_readme and isinstance(request_readme, str) and request_readme.strip():
        return request_readme.strip()[:6000]

    # 1. Try reading from volume tools (VM disk)
    try:
        readme_file = project.files.filter(path__iendswith="readme.md").first()
        if readme_file:
            from sandbox.services.volume_tools import read_file
            data = read_file(project, readme_file.path)
            if data:
                text = data.decode("utf-8", errors="ignore").strip()
                if text:
                    return text[:6000]
    except Exception:
        pass

    # 2. Try reading from local filesystem path if path exists
    try:
        if project.filesystem_path:
            from pathlib import Path
            root = Path(project.filesystem_path)
            for candidate in ["README.md", "readme.md", "README", "readme.txt"]:
                cand_path = root / candidate
                if cand_path.is_file():
                    text = cand_path.read_text(encoding="utf-8", errors="ignore").strip()
                    if text:
                        return text[:6000]
    except Exception:
        pass

    return ""


def generate_project_suggestions(project, request_readme=None) -> list:
    """Generate suggestions for a project using AI or heuristics."""
    file_paths = list(project.files.values_list("path", flat=True)[:50])
    if not file_paths and project.filesystem_path:
        try:
            import os
            from pathlib import Path
            root = Path(project.filesystem_path)
            if root.is_dir():
                disk_files = []
                for dirpath, _, filenames in os.walk(str(root)):
                    rel_dir = os.path.relpath(dirpath, str(root))
                    for fn in filenames:
                        if fn.startswith(".git"):
                            continue
                        rel_path = fn if rel_dir == "." else os.path.join(rel_dir, fn)
                        disk_files.append(rel_path)
                        if len(disk_files) >= 50:
                            break
                    if len(disk_files) >= 50:
                        break
                file_paths = disk_files
        except Exception:
            pass

    fallback = _get_fallback_suggestions(project, file_paths)
    # LLM suggestions run on the workspace's auxiliary model and its own key only.
    from sandbox.services.provider_keys import auxiliary_target
    target = auxiliary_target(project.workspace) if getattr(project, "workspace", None) else None
    if target is None:
        return fallback

    readme_content = _get_project_readme_content(project, request_readme)
    try:
        client = OpenAI(
            api_key=target["api_key"],
            base_url=target["base_url"] or None,
            timeout=15.0,
            max_retries=0,
        )
        model_name = target["model"]
        display_name = project.display_name or project.slug or "Project"
        description = project.description or ""
        filesystem_path = project.filesystem_path or ""

        prompt_sections = [
            f"Project Name: {display_name}",
            f"Description: {description or 'N/A'}",
            f"Root Path: {filesystem_path}",
        ]
        if readme_content:
            prompt_sections.append(
                f"--- README.md Content ---\n{readme_content[:4500]}\n-------------------------"
            )
        if file_paths:
            prompt_sections.append("Project Files (Sample):\n" + "\n".join(file_paths[:40]))

        prompt_content = "\n\n".join(prompt_sections)
        system_instruction = (
            "You are an expert software engineer and AI coding assistant embedded in a cloud workspace IDE. "
            "Analyze the provided README.md, project description, and file list carefully to understand: "
            "1) What this project actually does and its core domain/purpose. "
            "2) Its exact technology stack, entry point commands, run scripts, test runners, and architecture. "
            "Based on this understanding, generate 4-5 high-impact, concrete, actionable technical task prompts "
            "that a developer working on this project would execute next in the terminal or chat.\n"
            "Do NOT generate generic prompts (e.g. 'write code' or 'explain this'). Reference real commands, files, "
            "modules, APIs, or features discovered in the README.md.\n"
            "Return JSON strictly following this schema:\n"
            '{"suggestions": [{"label": "Short Action (2-4 words)", "prompt": "Complete prompt to send to the assistant...", "category": "run|test|debug|feature|git|arch"}]}'
        )

        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": prompt_content},
            ],
            response_format={"type": "json_object"},
            max_tokens=650,
            temperature=0.3,
        )

        import json
        raw_content = response.choices[0].message.content
        parsed = json.loads(raw_content) if raw_content else {}
        suggestions_list = parsed.get("suggestions", [])
        if isinstance(suggestions_list, list) and len(suggestions_list) > 0:
            clean_suggestions = []
            for item in suggestions_list[:5]:
                if isinstance(item, dict) and item.get("label") and item.get("prompt"):
                    clean_suggestions.append({
                        "label": str(item["label"]).strip()[:40],
                        "prompt": str(item["prompt"]).strip(),
                        "category": str(item.get("category", "code")).strip().lower(),
                    })
            if clean_suggestions:
                return clean_suggestions
    except Exception as exc:
        logger.warning("Failed to generate AI project suggestions for %s: %s", project.uuid, exc)

    return fallback


def generate_and_save_project_suggestions(project, request_readme=None, force=False) -> list:
    """Generate suggestions and save to database for the project."""
    if project.suggestions and isinstance(project.suggestions, list) and len(project.suggestions) > 0 and not force:
        return project.suggestions

    suggestions = generate_project_suggestions(project, request_readme=request_readme)
    if suggestions:
        project.suggestions = suggestions
        project.save(update_fields=["suggestions"])
        return suggestions
    return project.suggestions or []


def _bg_generate_project_suggestions(project_uuid: str):
    """Run in background thread during/after project creation."""
    from django.db import connection
    connection.close()
    try:
        from sandbox.models import Sandbox
        p = Sandbox.objects.filter(uuid=project_uuid).first()
        if p:
            ai_suggs = generate_project_suggestions(p)
            if ai_suggs:
                p.suggestions = ai_suggs
                p.save(update_fields=["suggestions"])
    except Exception as exc:
        logger.warning("Background project suggestion generation failed for %s: %s", project_uuid, exc)
    finally:
        connection.close()


def _init_project_suggestions_on_create(project):
    """Seed project suggestions once upon creation and refine with AI in background."""
    try:
        file_paths = list(project.files.values_list("path", flat=True)[:50])
        project.suggestions = _get_fallback_suggestions(project, file_paths)
        project.save(update_fields=["suggestions"])

        import sys
        if "test" in sys.argv:
            return

        import threading
        threading.Thread(
            target=_bg_generate_project_suggestions,
            args=(str(project.uuid),),
            daemon=True,
        ).start()
    except Exception as exc:
        logger.warning("Failed to initialize suggestions for project %s: %s", getattr(project, "uuid", None), exc)


class SandboxSuggestionsView(APIView):
    """
    Fetch or generate project-specific technical suggestions.
    Stored once on project creation and served from the database.
    """
    permission_classes = [permissions.IsAuthenticated]

    def _handle_suggestions(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        force = request.query_params.get("refresh") == "true"

        # If already stored in DB and not forcing a refresh, return directly from DB!
        if project.suggestions and isinstance(project.suggestions, list) and len(project.suggestions) > 0 and not force:
            return Response({"suggestions": project.suggestions, "source": "db"})

        request_readme = request.data.get("readme") if hasattr(request, "data") and isinstance(request.data, dict) else None
        suggestions = generate_and_save_project_suggestions(project, request_readme=request_readme, force=force)
        return Response({"suggestions": suggestions, "source": "ai"})

    def get(self, request, sandbox_uuid):
        return self._handle_suggestions(request, sandbox_uuid)

    def post(self, request, sandbox_uuid):
        return self._handle_suggestions(request, sandbox_uuid)

