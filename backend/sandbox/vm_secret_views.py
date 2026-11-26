"""REST API for encrypted workspace environment secrets."""
from __future__ import annotations

from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import permissions, serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from sandbox.models import Sandbox, WorkspaceMembership, WorkspaceVMSecret
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


def _resolve_optional_sandbox(workspace, raw_sandbox_uuid):
    if not raw_sandbox_uuid:
        return None
    return get_object_or_404(Sandbox, pk=raw_sandbox_uuid, workspace=workspace)


def serialize_workspace_secret(secret: WorkspaceVMSecret) -> dict:
    return {
        "uuid": str(secret.pk),
        "key": secret.key,
        "masked_value": mask_secret(secret.last4),
        "description": secret.description,
        "scope": "environment" if secret.sandbox_id else "workspace",
        "sandbox_uuid": str(secret.sandbox_id) if secret.sandbox_id else None,
        "created_by": secret.created_by.get_username() if secret.created_by_id else None,
        "created_at": secret.created_at.isoformat(),
        "updated_at": secret.updated_at.isoformat(),
    }


class SecretCreateSerializer(serializers.Serializer):
    key = serializers.CharField(max_length=128)
    value = serializers.CharField(write_only=True, max_length=32768, trim_whitespace=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")
    sandbox_uuid = serializers.UUIDField(required=False, allow_null=True, default=None)

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
    sandbox_uuid = serializers.UUIDField(required=False, allow_null=True, default=None)


class WorkspaceVMSecretsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, workspace_uuid):
        workspace, membership = _get_workspace_membership(request, workspace_uuid, require_manage=False)
        sandbox = _resolve_optional_sandbox(workspace, request.query_params.get("sandbox_uuid"))
        can_manage = membership.role in (
            WorkspaceMembership.ROLE_OWNER,
            WorkspaceMembership.ROLE_ADMIN,
        )
        if sandbox is not None:
            env_qs = WorkspaceVMSecret.objects.filter(workspace=workspace, sandbox=sandbox).select_related("created_by")
            env_keys = {item.key for item in env_qs}
            global_qs = WorkspaceVMSecret.objects.filter(workspace=workspace, sandbox__isnull=True).select_related("created_by")
            inherited = [
                {**serialize_workspace_secret(item), "overridden": item.key in env_keys}
                for item in global_qs
            ]
            payload = {
                "secrets": [serialize_workspace_secret(item) for item in env_qs],
                "inherited_secrets": inherited,
                "can_manage": can_manage,
            }
        else:
            qs = WorkspaceVMSecret.objects.filter(workspace=workspace, sandbox__isnull=True).select_related("created_by")
            payload = {
                "secrets": [serialize_workspace_secret(item) for item in qs],
                "can_manage": can_manage,
            }
        response = Response(payload)
        response["Cache-Control"] = "no-store"
        return response

    def post(self, request, workspace_uuid):
        workspace, _ = _get_workspace_membership(request, workspace_uuid, require_manage=True)
        serializer = SecretCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        data = serializer.validated_data
        sandbox = _resolve_optional_sandbox(workspace, data.get("sandbox_uuid"))
        encrypted_value, last4 = encrypt_secret(data["value"])

        try:
            with transaction.atomic():
                secret = WorkspaceVMSecret.objects.create(
                    workspace=workspace,
                    sandbox=sandbox,
                    key=data["key"],
                    encrypted_value=encrypted_value,
                    last4=last4,
                    description=(data.get("description") or "").strip(),
                    created_by=request.user,
                )
        except IntegrityError:
            scope_label = "environment" if sandbox else "workspace"
            raise ValidationError({"key": f"Secret '{data['key']}' already exists for this {scope_label}."})

        synced = sync_secrets_to_container(workspace) if sandbox is None else 0
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
            scope_label = "environment" if secret.sandbox_id else "workspace"
            raise ValidationError({"key": f"Secret '{secret.key}' already exists for this {scope_label}."})

        synced = sync_secrets_to_container(workspace) if secret.sandbox_id is None else 0
        response = Response({**serialize_workspace_secret(secret), "synced_containers": synced})
        response["Cache-Control"] = "no-store"
        return response

    def delete(self, request, workspace_uuid, secret_uuid):
        workspace, _ = _get_workspace_membership(request, workspace_uuid, require_manage=True)
        secret = get_object_or_404(WorkspaceVMSecret, pk=secret_uuid, workspace=workspace)
        was_global = secret.sandbox_id is None
        secret.delete()
        synced = sync_secrets_to_container(workspace) if was_global else 0
        response = Response({"deleted": True, "synced_containers": synced})
        response["Cache-Control"] = "no-store"
        return response


class WorkspaceVMSecretBulkImportView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, workspace_uuid):
        workspace, _ = _get_workspace_membership(request, workspace_uuid, require_manage=True)
        serializer = SecretBulkImportSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        sandbox = _resolve_optional_sandbox(workspace, serializer.validated_data.get("sandbox_uuid"))
        entries = parse_dotenv(serializer.validated_data["content"])

        created = 0
        updated = 0
        with transaction.atomic():
            for key, value in entries:
                encrypted_value, last4 = encrypt_secret(value)
                lookup = {"workspace": workspace, "key": key, "sandbox": sandbox}
                _, was_created = WorkspaceVMSecret.objects.update_or_create(
                    **lookup,
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

        synced = sync_secrets_to_container(workspace) if sandbox is None else 0
        response = Response({"imported": created + updated, "created": created, "updated": updated, "synced_containers": synced})
        response["Cache-Control"] = "no-store"
        return response
