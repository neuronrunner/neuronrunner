"""Serializers for the sandbox workspace models."""
from django.conf import settings
from django.utils import timezone
from rest_framework import serializers

from utils.image_placeholders import build_blur_data_url

from .models import (
    Sandbox,
    SandboxEvent,
    SandboxFile,
    Workspace,
    WorkspaceInvitation,
    WorkspaceMembership,
)


class WorkspaceMemberSerializer(serializers.ModelSerializer):
    user_uuid = serializers.UUIDField(source="user.uuid", read_only=True)
    username = serializers.CharField(source="user.username", read_only=True)
    email = serializers.EmailField(source="user.email", read_only=True)
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj):
        return obj.user.get_full_name() or obj.user.username

    class Meta:
        model = WorkspaceMembership
        fields = ("uuid", "user_uuid", "username", "email", "display_name", "role", "joined_at")
        read_only_fields = fields


class WorkspaceInvitationSerializer(serializers.ModelSerializer):
    workspace_uuid = serializers.UUIDField(source="workspace_id", read_only=True)
    workspace_name = serializers.CharField(source="workspace.name", read_only=True)
    invited_by_name = serializers.SerializerMethodField()

    def get_invited_by_name(self, obj):
        return obj.invited_by.get_full_name() or obj.invited_by.username

    class Meta:
        model = WorkspaceInvitation
        fields = (
            "uuid",
            "workspace_uuid",
            "workspace_name",
            "email",
            "role",
            "status",
            "expires_at",
            "invited_by_name",
            "created_at",
        )
        read_only_fields = fields


class WorkspaceSerializer(serializers.ModelSerializer):
    members = WorkspaceMemberSerializer(source="memberships", many=True, read_only=True)
    member_count = serializers.IntegerField(source="memberships.count", read_only=True)
    user_role = serializers.SerializerMethodField()
    owner_uuid = serializers.UUIDField(source="owner.uuid", read_only=True)
    pending_invitations = serializers.SerializerMethodField()
    profile_picture_blur_data_url = serializers.SerializerMethodField()

    def get_profile_picture_blur_data_url(self, obj):
        return build_blur_data_url(obj.profile_picture, cache_prefix='placeholder:workspace-picture')

    def validate_profile_picture(self, value):
        if value and getattr(value, 'size', 0) > settings.PROFILE_PICTURE_MAX_SIZE:
            raise serializers.ValidationError(
                f"Image file too large. Size cannot exceed {settings.PROFILE_PICTURE_MAX_SIZE / (1024 * 1024)} MB."
            )
        return value

    def to_internal_value(self, data):
        if 'profile_picture' in data and data['profile_picture'] in ('', None, 'null'):
            data = data.copy()
            data['profile_picture'] = None
        return super().to_internal_value(data)

    def update(self, instance, validated_data):
        if 'profile_picture' in validated_data:
            new_picture = validated_data['profile_picture']
            if instance.profile_picture:
                if not new_picture or (new_picture and instance.profile_picture.name != getattr(new_picture, 'name', '')):
                    try:
                        instance.profile_picture.delete(save=False)
                    except Exception:
                        pass
            instance.profile_picture = new_picture

        if 'name' in validated_data:
            instance.name = validated_data['name']

        instance.save()
        return instance

    def get_user_role(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return None
        membership = next(
            (item for item in obj.memberships.all() if item.user_id == request.user.pk),
            None,
        )
        return membership.role if membership else None

    def get_pending_invitations(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return []
        membership = next(
            (item for item in obj.memberships.all() if item.user_id == request.user.pk),
            None,
        )
        if not membership or membership.role not in (
            WorkspaceMembership.ROLE_OWNER,
            WorkspaceMembership.ROLE_ADMIN,
        ):
            return []
        invitations = [
            invitation
            for invitation in obj.invitations.all()
            if invitation.status == WorkspaceInvitation.STATUS_PENDING
            and invitation.expires_at > timezone.now()
        ]
        return WorkspaceInvitationSerializer(invitations, many=True).data

    class Meta:
        model = Workspace
        fields = (
            "uuid",
            "name",
            "slug",
            "profile_picture",
            "profile_picture_blur_data_url",
            "owner_uuid",
            "user_role",
            "member_count",
            "members",
            "pending_invitations",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "uuid",
            "owner_uuid",
            "user_role",
            "member_count",
            "members",
            "pending_invitations",
            "profile_picture_blur_data_url",
            "created_at",
            "updated_at",
        )

    def to_representation(self, instance):
        data = super().to_representation(instance)
        from core.extensions import registry as ext_registry
        request = self.context.get("request")
        extra = ext_registry.quota.workspace_summary(
            instance, user=getattr(request, "user", None)
        )
        if extra:
            data.update(extra)
        return data


class SandboxSerializer(serializers.ModelSerializer):
    conversation_ids = serializers.SerializerMethodField()
    workspace_uuid = serializers.UUIDField(source="workspace_id", read_only=True)
    vm_uuid = serializers.SerializerMethodField()

    def get_vm_uuid(self, obj):
        from core.extensions import registry as ext_registry
        return ext_registry.runtime.get_project_runtime_uuid(obj)

    def get_conversation_ids(self, obj):
        ids = [conversation.uuid for conversation in obj.conversations.all()]
        if obj.conversation_id and obj.conversation_id not in ids:
            ids.append(obj.conversation_id)
        return [str(conversation_id) for conversation_id in ids]

    class Meta:
        model = Sandbox
        fields = (
            "uuid",
            "slug",
            "display_name",
            "description",
            "workspace_uuid",
            "vm_uuid",
            "filesystem_path",
            "usage_guide",
            "conversation",
            "conversation_ids",
            "sandbox_gpu",
            "sandbox_cpu",
            "sandbox_memory",
            "sandbox_object_id",
            "sandbox_last_active_at",
            "r2_workspace_prefix",
            "idle_timeout_seconds",
            "is_favorite",
            "suggestions",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "uuid",
            "suggestions",
            "conversation_ids",
            "sandbox_gpu",
            "sandbox_object_id",
            "sandbox_last_active_at",
            "r2_workspace_prefix",
            "idle_timeout_seconds",
            "created_at",
            "updated_at",
        )

    def validate_filesystem_path(self, value):
        from pathlib import PurePosixPath

        raw = (value or "").strip()
        path = PurePosixPath(raw)
        if not raw.startswith("/workspace/") or ".." in path.parts:
            raise serializers.ValidationError("Path must be inside /workspace.")
        normalized = "/" + "/".join(part for part in path.parts if part != "/")
        user = self.context["request"].user
        workspace_id = self.instance.workspace_id if self.instance else self.initial_data.get("workspace_uuid")
        queryset = Sandbox.objects.filter(filesystem_path=normalized)
        if workspace_id:
            queryset = queryset.filter(workspace_id=workspace_id)
        else:
            queryset = queryset.filter(user=user)
        if self.instance:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError("This filesystem path is already a project.")
        return normalized


class SandboxCreateSerializer(serializers.ModelSerializer):
    """Serializer for creating/updating a sandbox."""

    class Meta:
        model = Sandbox
        fields = (
            "slug",
            "display_name",
            "description",
            "filesystem_path",
            "usage_guide",
            "sandbox_cpu",
            "sandbox_memory",
            "is_favorite",
        )

    def validate_filesystem_path(self, value):
        from pathlib import PurePosixPath

        raw = (value or "").strip()
        path = PurePosixPath(raw)
        if not raw.startswith("/workspace/") or ".." in path.parts:
            raise serializers.ValidationError("Path must be inside /workspace.")
        normalized = "/" + "/".join(part for part in path.parts if part != "/")
        user = self.context["request"].user
        workspace_id = self.instance.workspace_id if self.instance else self.initial_data.get("workspace_uuid")
        queryset = Sandbox.objects.filter(filesystem_path=normalized)
        if workspace_id:
            queryset = queryset.filter(workspace_id=workspace_id)
        else:
            queryset = queryset.filter(user=user)
        if self.instance:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError("This filesystem path is already a project.")
        return normalized

    def validate_slug(self, value):
        """Ensure slug is unique per user."""
        user = self.context["request"].user
        workspace_id = self.instance.workspace_id if self.instance else self.initial_data.get("workspace_uuid")
        queryset = Sandbox.objects.filter(slug=value)
        if workspace_id:
            queryset = queryset.filter(workspace_id=workspace_id)
        else:
            queryset = queryset.filter(user=user)
        if self.instance:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError("This slug is already in use.")
        return value


class SandboxFileSerializer(serializers.ModelSerializer):
    class Meta:
        model = SandboxFile
        fields = (
            "uuid",
            "path",
            "file_size_bytes",
            "mime_type",
            "is_directory",
            "modified_at",
            "created_at",
        )
        read_only_fields = (
            "uuid",
            "created_at",
        )


class SandboxFileCreateSerializer(serializers.Serializer):
    original_name = serializers.CharField(max_length=255)
    r2_object_key = serializers.CharField(max_length=512)
    file_size = serializers.IntegerField(min_value=0, default=0)
    mime_type = serializers.CharField(max_length=80, default="application/octet-stream")


class SandboxEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = SandboxEvent
        fields = (
            "uuid",
            "event_type",
            "payload",
            "duration_ms",
            "success",
            "error_message",
            "created_at",
        )
        read_only_fields = (
            "uuid",
            "event_type",
            "payload",
            "duration_ms",
            "success",
            "error_message",
            "created_at",
        )


class SandboxRuntimeSerializer(serializers.ModelSerializer):
    """For embedding sandbox's runtime info."""
    class Meta:
        model = Sandbox
        fields = ("uuid", "slug", "display_name", "sandbox_gpu", "sandbox_object_id")


class SandboxGenerateRequestSerializer(serializers.Serializer):
    model_slug = serializers.CharField(max_length=255)
    inputs = serializers.DictField()
    gpu_preference = serializers.CharField(max_length=50, required=False, allow_blank=True, default="")
    return_type = serializers.CharField(max_length=50, required=False, allow_blank=True, default="image")
    conversation_id = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")
    region = serializers.CharField(max_length=50, required=False, allow_blank=True, default="")
