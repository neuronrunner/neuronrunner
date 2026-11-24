"""REST API for encrypted workspace environment secrets."""
from __future__ import annotations

from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import permissions, serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from sandbox.models import WorkspaceMembership, WorkspaceVMSecret
from sandbox.services.vm_secrets import (
    encrypt_secret,
    mask_secret,
    parse_dotenv,
    sync_secrets_to_container,
    validate_secret_key,
    validate_secret_value,
)


def _get_workspace_membership(request, workspace_uuid, *, require_manage: bool = False):
    membership = get_object_or_404(
        WorkspaceMembership.objects.select_related("workspace"),
        workspace_id=workspace_uuid,
        user=request.user,
    )
    if require_manage and membership.role not in (
        WorkspaceMembership.ROLE_OWNER,
        WorkspaceMembership.ROLE_ADMIN,
    ):
        raise PermissionDenied("Only workspace owners or admins can manage workspace secrets.")
    return membership.workspace, membership


def serialize_workspace_secret(secret: WorkspaceVMSecret) -> dict:
    return {
        "uuid": str(secret.pk),
        "key": secret.key,
        "masked_value": mask_secret(secret.last4),
        "description": secret.description,
        "scope": "workspace",
        "created_by": secret.created_by.get_username() if secret.created_by_id else None,
        "created_at": secret.created_at.isoformat(),
        "updated_at": secret.updated_at.isoformat(),
    }


class SecretCreateSerializer(serializers.Serializer):
    key = serializers.CharField(max_length=128)
    value = serializers.CharField(write_only=True, max_length=32768, trim_whitespace=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")

    def validate_key(self, value):
        return validate_secret_key(value)

    def validate_value(self, value):
        return validate_secret_value(value)


class SecretUpdateSerializer(serializers.Serializer):
    key = serializers.CharField(max_length=128, required=False)
    value = serializers.CharField(
        write_only=True,
        max_length=32768,
        required=False,
        allow_blank=True,
        trim_whitespace=False,
    )
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)

    def validate_key(self, value):
        return validate_secret_key(value)

    def validate_value(self, value):
        if value == "":
            return ""
        return validate_secret_value(value)


class SecretBulkImportSerializer(serializers.Serializer):
    content = serializers.CharField(write_only=True, max_length=131072, trim_whitespace=False)


class WorkspaceVMSecretsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, workspace_uuid):
        workspace, membership = _get_workspace_membership(request, workspace_uuid, require_manage=False)
        qs = WorkspaceVMSecret.objects.filter(workspace=workspace).select_related("created_by")
        can_manage = membership.role in (
            WorkspaceMembership.ROLE_OWNER,
            WorkspaceMembership.ROLE_ADMIN,
        )
        response = Response({
            "secrets": [serialize_workspace_secret(item) for item in qs],
            "can_manage": can_manage,
        })
        response["Cache-Control"] = "no-store"
        return response

    def post(self, request, workspace_uuid):
        workspace, _ = _get_workspace_membership(request, workspace_uuid, require_manage=True)
        serializer = SecretCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        data = serializer.validated_data
        encrypted_value, last4 = encrypt_secret(data["value"])

        try:
            with transaction.atomic():
                secret = WorkspaceVMSecret.objects.create(
                    workspace=workspace,
                    key=data["key"],
                    encrypted_value=encrypted_value,
                    last4=last4,
                    description=(data.get("description") or "").strip(),
                    created_by=request.user,
                )
        except IntegrityError:
            raise ValidationError({"key": f"Secret '{data['key']}' already exists for this workspace."})

        synced = sync_secrets_to_container(workspace)
        response = Response({**serialize_workspace_secret(secret), "synced_containers": synced}, status=201)
        response["Cache-Control"] = "no-store"
        return response


class WorkspaceVMSecretDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def patch(self, request, workspace_uuid, secret_uuid):
        workspace, _ = _get_workspace_membership(request, workspace_uuid, require_manage=True)
        secret = get_object_or_404(WorkspaceVMSecret, pk=secret_uuid, workspace=workspace)
        serializer = SecretUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        if "key" in data:
            secret.key = data["key"]
        if data.get("value"):
            secret.encrypted_value, secret.last4 = encrypt_secret(data["value"])
        if "description" in data:
            secret.description = (data["description"] or "").strip()

        try:
            with transaction.atomic():
                secret.save()
        except IntegrityError:
            raise ValidationError({"key": f"Secret '{secret.key}' already exists for this workspace."})

        synced = sync_secrets_to_container(workspace)
        response = Response({**serialize_workspace_secret(secret), "synced_containers": synced})
        response["Cache-Control"] = "no-store"
        return response

    def delete(self, request, workspace_uuid, secret_uuid):
        workspace, _ = _get_workspace_membership(request, workspace_uuid, require_manage=True)
        secret = get_object_or_404(WorkspaceVMSecret, pk=secret_uuid, workspace=workspace)
        secret.delete()
        synced = sync_secrets_to_container(workspace)
        response = Response({"deleted": True, "synced_containers": synced})
        response["Cache-Control"] = "no-store"
        return response


class WorkspaceVMSecretBulkImportView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, workspace_uuid):
        workspace, _ = _get_workspace_membership(request, workspace_uuid, require_manage=True)
        serializer = SecretBulkImportSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        entries = parse_dotenv(serializer.validated_data["content"])

        created = 0
        updated = 0
        with transaction.atomic():
            for key, value in entries:
                encrypted_value, last4 = encrypt_secret(value)
                _, was_created = WorkspaceVMSecret.objects.update_or_create(
                    workspace=workspace,
                    key=key,
                    defaults={
                        "encrypted_value": encrypted_value,
                        "last4": last4,
                        "created_by": request.user,
                    },
                )
                if was_created:
                    created += 1
                else:
                    updated += 1

        synced = sync_secrets_to_container(workspace)
        response = Response({"imported": created + updated, "created": created, "updated": updated, "synced_containers": synced})
        response["Cache-Control"] = "no-store"
        return response
