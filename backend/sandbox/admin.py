"""Admin registrations for the sandbox workspace models."""
from django.contrib import admin

from .models import (
    Sandbox,
    SandboxAuditLog,
    SandboxEvent,
    SandboxFile,
    Workspace,
    WorkspaceInvitation,
    WorkspaceMembership,
    WorkspaceVMSecret,
)


class WorkspaceMembershipInline(admin.TabularInline):
    model = WorkspaceMembership
    extra = 0


class WorkspaceInvitationInline(admin.TabularInline):
    model = WorkspaceInvitation
    extra = 0
    readonly_fields = ("uuid", "token", "created_at", "updated_at")


@admin.register(Workspace)
class WorkspaceAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "owner", "profile_picture", "created_at")
    search_fields = ("name", "slug", "owner__username", "owner__email")
    readonly_fields = ("uuid", "created_at", "updated_at")
    inlines = [WorkspaceMembershipInline, WorkspaceInvitationInline]


@admin.register(WorkspaceInvitation)
class WorkspaceInvitationAdmin(admin.ModelAdmin):
    list_display = ("email", "workspace", "role", "status", "expires_at", "invited_by", "created_at")
    list_filter = ("role", "status")
    search_fields = ("email", "workspace__name", "invited_by__username", "invited_by__email")
    readonly_fields = ("uuid", "token", "created_at", "updated_at")


class SandboxFileInline(admin.TabularInline):
    model = SandboxFile
    extra = 0
    readonly_fields = ("path", "file_size_bytes", "mime_type", "is_directory", "modified_at", "last_seen_at", "created_at")
    can_delete = False


class SandboxEventInline(admin.TabularInline):
    model = SandboxEvent
    extra = 0
    readonly_fields = ("event_type", "duration_ms", "success", "error_message", "created_at")
    can_delete = False


@admin.register(Sandbox)
class SandboxAdmin(admin.ModelAdmin):
    list_display = ("slug", "display_name", "workspace", "user", "sandbox_cpu", "sandbox_memory", "sandbox_last_active_at", "created_at")
    list_filter = ("created_at",)
    search_fields = ("slug", "display_name", "user__username")
    readonly_fields = ("uuid", "sandbox_object_id", "created_at", "updated_at")
    inlines = [SandboxFileInline, SandboxEventInline]


@admin.register(SandboxFile)
class SandboxFileAdmin(admin.ModelAdmin):
    list_display = ("sandbox", "path", "file_size_bytes", "mime_type", "is_directory", "last_seen_at")
    list_filter = ("is_directory", "last_seen_at")
    search_fields = ("path", "sandbox__slug", "sandbox__display_name")
    readonly_fields = ("uuid", "last_seen_at", "created_at")


@admin.register(SandboxEvent)
class SandboxEventAdmin(admin.ModelAdmin):
    list_display = ("sandbox", "event_type", "duration_ms", "success", "created_at")
    list_filter = ("event_type", "success", "created_at")
    search_fields = ("sandbox__slug", "sandbox__display_name", "event_type")
    readonly_fields = ("uuid", "created_at")


@admin.register(SandboxAuditLog)
class SandboxAuditLogAdmin(admin.ModelAdmin):
    list_display = ("created_at", "event_type", "user_email_snapshot", "ip_address", "runtime_id", "command_preview")
    list_filter = ("event_type", "created_at")
    search_fields = ("runtime_id", "user_email_snapshot", "user_id_snapshot", "ip_address", "command")
    readonly_fields = (
        "uuid", "event_type", "user", "user_id_snapshot", "user_email_snapshot",
        "workspace", "workspace_id_snapshot", "runtime_id",
        "sandbox", "sandbox_uuid_snapshot", "ip_address", "user_agent", "command",
        "metadata", "created_at",
    )

    @admin.display(description="Command")
    def command_preview(self, obj):
        return obj.command[:80] if obj.command else ""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(WorkspaceVMSecret)
class WorkspaceSecretAdmin(admin.ModelAdmin):
    list_display = ("key", "workspace", "last4", "created_by", "updated_at")
    search_fields = ("key", "workspace__name", "description")
    readonly_fields = ("uuid", "encrypted_value", "last4", "created_at", "updated_at")
