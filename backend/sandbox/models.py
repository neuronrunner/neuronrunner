"""
Sandbox Runtime Models
=======================
Models for team workspaces and their projects:
  - Workspace         : collaboration, membership, and shared filesystem boundary
  - WorkspaceProviderKey: encrypted BYOK provider API keys
  - Sandbox           : a project folder inside a workspace
  - SandboxFile       : cached file metadata inside a workspace
  - SandboxEvent      : audit trail for workspace lifecycle events
  - SandboxAuditLog   : immutable command/terminal attribution log
  - WorkspaceVMSecret : encrypted environment secrets injected into containers
"""
from __future__ import annotations

import os
import random
import string
import uuid
from datetime import timedelta
from uuid import uuid4

from django.conf import settings
from django.db import models
from django.utils import timezone


def default_workspace_invitation_expiry():
    """Give team invitations a bounded lifetime instead of permanent access links."""
    return timezone.now() + timedelta(days=7)


def workspace_picture_upload_path(instance, filename):
    """Generate an upload path for workspace profile pictures."""
    ext = filename.split('.')[-1]
    random_str = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    slug_or_uuid = getattr(instance, 'slug', None) or getattr(instance, 'uuid', None) or 'workspace'
    filename = f"workspace-{slug_or_uuid}-{random_str}.{ext}"
    return os.path.join('workspace_pictures', filename)


class Workspace(models.Model):
    """A collaboration boundary that owns projects and team membership."""

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=60)
    storage_key = models.CharField(max_length=80, unique=True, default=uuid4, editable=False)
    profile_picture = models.ImageField(
        upload_to=workspace_picture_upload_path,
        blank=True,
        null=True,
    )
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="owned_workspaces",
    )
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        through="WorkspaceMembership",
        related_name="team_workspaces",
    )
    # Model the workspace's own key runs side calls on (titles, summaries, memory,
    # suggestions). Empty means the chat model itself is used.
    auxiliary_model = models.ForeignKey(
        "model.Model",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    @property
    def email(self):
        return self.owner.email

    class Meta:
        ordering = ["-updated_at"]
        unique_together = (("owner", "slug"),)
        indexes = [models.Index(fields=["owner", "-updated_at"])]

    def __str__(self) -> str:
        return self.name


class WorkspaceProviderKey(models.Model):
    """Encrypted, write-only provider credentials shared by a workspace."""

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="provider_keys")
    provider = models.CharField(max_length=32)
    base_url = models.URLField(max_length=512, blank=True, default="")
    encrypted_key = models.TextField(editable=False, blank=True, default="")
    last4 = models.CharField(max_length=4, editable=False, blank=True, default="")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "provider"], name="unique_workspace_provider_key")
        ]

    def __str__(self):
        return f"{self.workspace_id}: {self.provider}"


class WorkspaceMembership(models.Model):
    ROLE_OWNER = "owner"
    ROLE_ADMIN = "admin"
    ROLE_MEMBER = "member"
    ROLE_CHOICES = (
        (ROLE_OWNER, "Owner"),
        (ROLE_ADMIN, "Admin"),
        (ROLE_MEMBER, "Member"),
    )

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="workspace_memberships",
    )
    role = models.CharField(max_length=12, choices=ROLE_CHOICES, default=ROLE_MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["joined_at"]
        unique_together = (("workspace", "user"),)
        indexes = [
            models.Index(fields=["workspace", "role"]),
            models.Index(fields=["user", "workspace"]),
        ]

    def __str__(self) -> str:
        return f"{self.user} in {self.workspace} ({self.role})"


class WorkspaceInvitation(models.Model):
    """An emailed, explicit opt-in to join a team workspace."""

    STATUS_PENDING = "pending"
    STATUS_ACCEPTED = "accepted"
    STATUS_DECLINED = "declined"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_ACCEPTED, "Accepted"),
        (STATUS_DECLINED, "Declined"),
        (STATUS_EXPIRED, "Expired"),
    )

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="invitations",
    )
    email = models.EmailField()
    role = models.CharField(
        max_length=12,
        choices=WorkspaceMembership.ROLE_CHOICES,
        default=WorkspaceMembership.ROLE_MEMBER,
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sent_workspace_invitations",
    )
    token = models.UUIDField(default=uuid4, unique=True, editable=False)
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_PENDING)
    expires_at = models.DateTimeField(default=default_workspace_invitation_expiry)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["workspace", "status"]),
            models.Index(fields=["email", "status"]),
        ]

    def __str__(self) -> str:
        return f"{self.email} invited to {self.workspace} ({self.status})"


class Sandbox(models.Model):
    """A repo-backed Environment (project) inside a workspace."""

    SETUP_STATUS_IDLE = "idle"
    SETUP_STATUS_RUNNING = "running"
    SETUP_STATUS_READY = "ready"
    SETUP_STATUS_FAILED = "failed"
    SETUP_STATUS_CHOICES = (
        (SETUP_STATUS_IDLE, "Idle"),
        (SETUP_STATUS_RUNNING, "Running"),
        (SETUP_STATUS_READY, "Ready"),
        (SETUP_STATUS_FAILED, "Failed"),
    )

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sandboxes",
    )
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="projects",
        null=True,
        blank=True,
        help_text="Team workspace that owns this project.",
    )

    slug = models.SlugField(max_length=60)
    display_name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    filesystem_path = models.CharField(
        max_length=512,
        blank=True,
        default="",
        help_text="Absolute project directory inside the shared /workspace filesystem.",
    )

    conversation = models.ForeignKey(
        "chat.Conversation",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sandboxes",
        help_text="Conversation this sandbox is bound to (1:1).",
    )
    conversations = models.ManyToManyField(
        "chat.Conversation",
        blank=True,
        related_name="workspaces",
        help_text="Conversation history scoped to this project.",
    )

    # Container runtime state
    sandbox_object_id = models.CharField(max_length=80, blank=True, default="")
    sandbox_gpu = models.CharField(max_length=20, blank=True, default="CPU")
    sandbox_cpu = models.FloatField(default=2.0, help_text="Number of CPU cores.")
    sandbox_memory = models.IntegerField(default=4096, help_text="RAM in Megabytes.")
    sandbox_last_active_at = models.DateTimeField(null=True, blank=True)

    r2_workspace_prefix = models.CharField(max_length=200, blank=True, default="")
    workspace_mount_path = models.CharField(max_length=24, blank=True, default="")
    terminal_url = models.CharField(max_length=512, blank=True, default="")
    terminal_token = models.CharField(max_length=128, blank=True, default="")

    usage_guide = models.TextField(
        blank=True,
        default="",
        help_text="Instructions for the agent on how to use this environment.",
    )
    # Environment blueprint fields (repo binding, setup/maintenance scripts, state/deps metadata)
    repo_full_name = models.CharField(
        max_length=200,
        blank=True,
        default="",
        help_text="Connected GitHub repository in owner/repo format.",
    )
    repo_url = models.CharField(
        max_length=512,
        blank=True,
        default="",
        help_text="Git clone URL when linked to a repository.",
    )
    default_branch = models.CharField(
        max_length=120,
        blank=True,
        default="",
        help_text="Default Git branch checked out for this environment.",
    )
    working_subdir = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Optional relative subdirectory inside the repository (for monorepos).",
    )
    setup_script = models.TextField(
        blank=True,
        default="",
        help_text="Shell script run once after cloning or when dependencies change.",
    )
    maintenance_script = models.TextField(
        blank=True,
        default="",
        help_text="Shell script run when a new conversation worktree is created.",
    )
    setup_status = models.CharField(
        max_length=16,
        choices=SETUP_STATUS_CHOICES,
        default=SETUP_STATUS_IDLE,
    )
    setup_last_run_at = models.DateTimeField(null=True, blank=True)
    setup_last_log = models.TextField(blank=True, default="")
    state_saved_at = models.DateTimeField(null=True, blank=True)
    state_size_bytes = models.BigIntegerField(default=0)
    deps_lock_hash = models.CharField(max_length=64, blank=True, default="")

    suggestions = models.JSONField(
        default=list,
        blank=True,
        help_text="Project-specific prompt suggestions generated once upon creation.",
    )
    is_favorite = models.BooleanField(default=False)
    idle_timeout_seconds = models.IntegerField(
        default=1800,
        help_text="Seconds of inactivity before the container is stopped.",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        unique_together = (("workspace", "slug"),)
        constraints = [
            models.UniqueConstraint(
                fields=["workspace"],
                condition=models.Q(filesystem_path="/workspace"),
                name="one_files_root_per_workspace",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "-updated_at"]),
            models.Index(fields=["conversation"]),
            models.Index(fields=["sandbox_object_id"]),
        ]

    def __str__(self) -> str:
        return f"{self.display_name} ({getattr(self, 'user_id', getattr(self, 'user', ''))})"

    def tier_idle_seconds(self, tier: str) -> int:
        return getattr(settings, "SANDBOX_IDLE_TIMEOUT_DEFAULT", 1800)


class SandboxFile(models.Model):
    """Cached listing of files inside a sandbox's workspace."""

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sandbox = models.ForeignKey(
        Sandbox,
        on_delete=models.CASCADE,
        related_name="files",
    )
    path = models.CharField(max_length=512, help_text="In-sandbox path, e.g. /workspace/foo.txt")
    file_size_bytes = models.BigIntegerField(default=0)
    mime_type = models.CharField(max_length=80, blank=True, default="text/plain")
    is_directory = models.BooleanField(default=False)
    modified_at = models.DateTimeField(null=True, blank=True)
    last_seen_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = (("sandbox", "path"),)
        ordering = ["path"]
        indexes = [
            models.Index(fields=["sandbox", "path"]),
        ]

    def __str__(self) -> str:
        return self.path


class SandboxEvent(models.Model):
    """Audit trail for sandbox lifecycle events."""

    EVENT_SPAWN = "spawn"
    EVENT_REUSE = "reuse"
    EVENT_RELEASE = "release"
    EVENT_FILE_WRITE = "file_write"
    EVENT_FILE_READ = "file_read"
    EVENT_SHELL = "shell"
    EVENT_HTTP = "http"

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sandbox = models.ForeignKey(
        Sandbox,
        on_delete=models.CASCADE,
        related_name="sandbox_events",
    )
    event_type = models.CharField(max_length=32)
    payload = models.JSONField(default=dict, blank=True)
    duration_ms = models.IntegerField(default=0)
    success = models.BooleanField(default=True)
    error_message = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["sandbox", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.sandbox_id} {self.event_type}"


class SandboxAuditLog(models.Model):
    """Immutable attribution and command audit log that survives sandbox deletion."""

    EVENT_TERMINAL_CONNECT = "terminal_connect"
    EVENT_TERMINAL_COMMAND = "terminal_command"
    EVENT_SHELL_EXEC = "shell_exec"

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event_type = models.CharField(max_length=40, db_index=True)

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sandbox_audit_logs",
    )
    user_id_snapshot = models.CharField(max_length=64, blank=True, default="", db_index=True)
    user_email_snapshot = models.CharField(max_length=254, blank=True, default="")

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sandbox_audit_logs",
    )
    workspace_id_snapshot = models.CharField(max_length=64, blank=True, default="", db_index=True)

    runtime_id = models.CharField(max_length=80, blank=True, default="", db_index=True)

    sandbox = models.ForeignKey(
        Sandbox,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audit_logs",
    )
    sandbox_uuid_snapshot = models.CharField(max_length=64, blank=True, default="")

    ip_address = models.GenericIPAddressField(null=True, blank=True, db_index=True)
    user_agent = models.CharField(max_length=512, blank=True, default="")
    command = models.TextField(blank=True, default="")
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["runtime_id", "-created_at"], name="sbaudit_runtime_created_idx"),
            models.Index(fields=["user_id_snapshot", "-created_at"], name="sbaudit_user_created_idx"),
            models.Index(fields=["ip_address", "-created_at"], name="sbaudit_ip_created_idx"),
        ]

    def __str__(self) -> str:
        actor = self.user_email_snapshot or self.user_id_snapshot or "unknown"
        return f"[{self.created_at:%Y-%m-%d %H:%M}] {self.event_type} by {actor} ({self.runtime_id or '-'})"


class WorkspaceVMSecret(models.Model):
    """Encrypted environment secrets injected into workspace or environment runtimes."""

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="vm_secrets",
    )
    sandbox = models.ForeignKey(
        Sandbox,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="secrets",
        help_text="When set, this secret is scoped to a single Environment and overrides workspace-level secrets.",
    )
    key = models.CharField(max_length=128)
    encrypted_value = models.TextField(editable=False, default="")
    last4 = models.CharField(max_length=8, editable=False, blank=True, default="")
    description = models.CharField(max_length=255, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["key", "-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "key"],
                condition=models.Q(sandbox__isnull=True),
                name="unique_workspace_global_secret_key",
            ),
            models.UniqueConstraint(
                fields=["workspace", "sandbox", "key"],
                condition=models.Q(sandbox__isnull=False),
                name="unique_environment_secret_key",
            ),
        ]

    def __str__(self) -> str:
        scope = f"{self.workspace_id}/{self.sandbox_id}" if self.sandbox_id else str(self.workspace_id)
        return f"{scope}:{self.key}"
