"""Tests for encrypted workspace secret management, API, and runtime injection."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sandbox.models import Workspace, WorkspaceMembership, WorkspaceVMSecret
from sandbox.services import file_tools, vm_secrets


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    SECURE_SSL_REDIRECT=False,
)
class WorkspaceSecretsTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.owner = User.objects.create_user(username="sec-owner", email="sec-owner@example.com")
        self.admin = User.objects.create_user(username="sec-admin", email="sec-admin@example.com")
        self.member = User.objects.create_user(username="sec-member", email="sec-member@example.com")
        self.outsider = User.objects.create_user(username="sec-out", email="sec-out@example.com")

        self.workspace = Workspace.objects.create(
            owner=self.owner,
            name="Secrets WS",
            slug="secrets-ws",
        )
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.owner, role="owner")
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.admin, role="admin")
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.member, role="member")

        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.base_url = f"/sandbox/workspaces/{self.workspace.uuid}/vm-secrets/"

    def test_encrypt_decrypt_and_short_secret_masking(self):
        enc_long, last4_long = vm_secrets.encrypt_secret("sk_test_1234567890")
        self.assertEqual(last4_long, "7890")
        self.assertEqual(vm_secrets.decrypt_secret(enc_long), "sk_test_1234567890")
        self.assertEqual(vm_secrets.mask_secret(last4_long), "••••7890")

        enc_short, last4_short = vm_secrets.encrypt_secret("abc")
        self.assertEqual(last4_short, "")
        self.assertEqual(vm_secrets.decrypt_secret(enc_short), "abc")
        self.assertEqual(vm_secrets.mask_secret(last4_short), "••••••••")

    def test_resolve_workspace_secrets(self):
        e1, l1 = vm_secrets.encrypt_secret("ws-db-url")
        e2, l2 = vm_secrets.encrypt_secret("ws-only-val")
        WorkspaceVMSecret.objects.create(
            workspace=self.workspace, key="DATABASE_URL", encrypted_value=e1, last4=l1
        )
        WorkspaceVMSecret.objects.create(
            workspace=self.workspace, key="SHARED_TOKEN", encrypted_value=e2, last4=l2
        )

        resolved_ws = vm_secrets.resolve_vm_secrets(self.workspace)
        self.assertEqual(resolved_ws, {"DATABASE_URL": "ws-db-url", "SHARED_TOKEN": "ws-only-val"})

    def test_api_crud_and_permissions(self):
        with mock.patch("sandbox.vm_secret_views.sync_secrets_to_container", return_value=1) as sync_mock:
            res = self.client.post(
                self.base_url,
                {
                    "key": "API_SECRET_KEY",
                    "value": "sk_live_supersecret_9999",
                    "description": "Service key",
                },
                format="json",
            )
            self.assertEqual(res.status_code, 201)
            body = res.json()
            self.assertEqual(body["key"], "API_SECRET_KEY")
            self.assertEqual(body["masked_value"], "••••9999")
            self.assertNotIn("sk_live_supersecret_9999", res.content.decode())
            self.assertEqual(body["synced_containers"], 1)
            sync_mock.assert_called_once()

        secret_uuid = body["uuid"]

        # Duplicate key in same workspace is rejected
        dup = self.client.post(
            self.base_url,
            {"key": "API_SECRET_KEY", "value": "sk_live_another_1111"},
            format="json",
        )
        self.assertEqual(dup.status_code, 400)

        # Member can list masked metadata, cannot create/update/delete
        member_client = APIClient()
        member_client.force_authenticate(self.member)
        list_res = member_client.get(self.base_url)
        self.assertEqual(list_res.status_code, 200)
        self.assertFalse(list_res.json()["can_manage"])
        self.assertEqual(len(list_res.json()["secrets"]), 1)
        self.assertNotIn("sk_live_supersecret_9999", list_res.content.decode())

        self.assertEqual(
            member_client.post(self.base_url, {"key": "A", "value": "12345678"}, format="json").status_code,
            403,
        )
        self.assertEqual(
            member_client.delete(f"{self.base_url}{secret_uuid}/").status_code,
            403,
        )

        # Outsider gets 404
        outsider_client = APIClient()
        outsider_client.force_authenticate(self.outsider)
        self.assertEqual(outsider_client.get(self.base_url).status_code, 404)

        # Owner can patch description without overwriting secret value
        with mock.patch("sandbox.vm_secret_views.sync_secrets_to_container", return_value=1):
            patch_res = self.client.patch(
                f"{self.base_url}{secret_uuid}/",
                {"description": "Updated desc", "value": ""},
                format="json",
            )
            self.assertEqual(patch_res.status_code, 200)
            self.assertEqual(patch_res.json()["description"], "Updated desc")
            self.assertEqual(patch_res.json()["masked_value"], "••••9999")
            row = WorkspaceVMSecret.objects.get(pk=secret_uuid)
            self.assertEqual(vm_secrets.decrypt_secret(row.encrypted_value), "sk_live_supersecret_9999")

        # Owner can delete
        with mock.patch("sandbox.vm_secret_views.sync_secrets_to_container", return_value=1):
            del_res = self.client.delete(f"{self.base_url}{secret_uuid}/")
            self.assertEqual(del_res.status_code, 200)
            self.assertFalse(WorkspaceVMSecret.objects.filter(pk=secret_uuid).exists())

    def test_rejects_reserved_and_invalid_keys(self):
        for bad_key in ("PATH", "HOME", "WORKSPACE_ROOT", "123_BAD", "BAD-KEY", "A B"):
            res = self.client.post(
                self.base_url,
                {"key": bad_key, "value": "some-secret-value"},
                format="json",
            )
            self.assertEqual(res.status_code, 400, f"Expected 400 for key={bad_key}")

    def test_bulk_import_dotenv(self):
        content = (
            "# Comment\n"
            "API_KEY=secret_value_one\n"
            "export DB_PASS='quoted_pass_1234'\n"
            'JWT_SECRET="double_quoted_5678"\n'
        )
        with mock.patch("sandbox.vm_secret_views.sync_secrets_to_container", return_value=1):
            res = self.client.post(
                f"{self.base_url}bulk-import/",
                {"content": content},
                format="json",
            )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["imported"], 3)
        resolved = vm_secrets.resolve_vm_secrets(self.workspace)
        self.assertEqual(resolved["API_KEY"], "secret_value_one")
        self.assertEqual(resolved["DB_PASS"], "quoted_pass_1234")
        self.assertEqual(resolved["JWT_SECRET"], "double_quoted_5678")

    def test_guest_helpers_apply_secrets_file_safely(self):
        with tempfile.TemporaryDirectory() as tmp:
            secrets_file = Path(tmp) / "secrets.json"
            secrets_file.write_text(
                json.dumps({"MY_SECRET": "topsecret", "PATH": "/evil"}),
                encoding="utf-8",
            )

            tool_env = {"PATH": "/usr/bin"}
            with mock.patch.object(file_tools, "SECRETS_PATH", secrets_file):
                file_tools._apply_vm_secrets(tool_env)
            self.assertEqual(tool_env["MY_SECRET"], "topsecret")
            self.assertEqual(tool_env["PATH"], "/usr/bin")
