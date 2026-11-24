"""Tests for immutable SandboxAuditLog attribution and SandboxEvent recording."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from sandbox.models import Sandbox, SandboxAuditLog, SandboxEvent, Workspace
from sandbox.services.audit_log import (
    extract_client_ip_from_request,
    extract_client_ip_from_scope,
    record_sandbox_audit,
)
from sandbox.services.sandbox_session import SandboxSessionManager

User = get_user_model()


class SandboxAuditLogTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="audit_user",
            email="audit@example.com",
            password="pw",
        )
        self.workspace = Workspace.objects.create(name="Audit WS", owner=self.user)
        self.sandbox = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="audit-proj",
            filesystem_path="/workspace/audit-proj",
            sandbox_object_id="nr-sandbox-workspace-audit",
        )

    def test_extract_client_ip_from_request_prefers_valid_xff(self):
        rf = RequestFactory()
        req = rf.get("/", HTTP_X_FORWARDED_FOR="203.0.113.5, 10.0.0.1", REMOTE_ADDR="127.0.0.1")
        self.assertEqual(extract_client_ip_from_request(req), "203.0.113.5")

    def test_extract_client_ip_from_scope(self):
        scope = {
            "headers": [(b"x-forwarded-for", b"198.51.100.42, 10.0.0.2"), (b"user-agent", b"TestWS/1.0")],
            "client": ("127.0.0.1", 55555),
        }
        self.assertEqual(extract_client_ip_from_scope(scope), "198.51.100.42")

    def test_audit_log_survives_sandbox_deletion(self):
        rf = RequestFactory()
        req = rf.post(
            "/sandbox/sandboxes/",
            REMOTE_ADDR="192.0.2.99",
            HTTP_USER_AGENT="Mozilla/5.0 Test",
        )
        entry = record_sandbox_audit(
            event_type=SandboxAuditLog.EVENT_TERMINAL_CONNECT,
            user=self.user,
            workspace=self.workspace,
            sandbox=self.sandbox,
            runtime_id="nr-sandbox-workspace-audit",
            request=req,
            command="echo audit",
        )
        self.assertIsNotNone(entry)
        sb_pk = str(self.sandbox.pk)

        self.sandbox.delete()

        entry.refresh_from_db()
        self.assertIsNone(entry.sandbox)
        self.assertEqual(entry.runtime_id, "nr-sandbox-workspace-audit")
        self.assertEqual(entry.sandbox_uuid_snapshot, sb_pk)
        self.assertEqual(entry.user_email_snapshot, "audit@example.com")
        self.assertEqual(entry.ip_address, "192.0.2.99")
        self.assertEqual(entry.user_agent, "Mozilla/5.0 Test")
        self.assertEqual(entry.command, "echo audit")

    def test_execute_tool_records_sandbox_event_and_shell_audit(self):
        manager = SandboxSessionManager()
        fake_sandbox = MagicMock()
        fake_sandbox.exec.return_value = SimpleNamespace(
            stdout=SimpleNamespace(read=lambda: b'{"stdout": "ok\\n", "stderr": "", "exit_code": 0}'),
            stderr=SimpleNamespace(read=lambda: b""),
            wait=lambda timeout=None: 0,
        )
        with patch.object(manager, "get_or_create", return_value=fake_sandbox), patch.object(
            manager, "_sync_file_tree_to_db"
        ):
            res = manager.execute_tool(self.sandbox, "shell_exec", {"command": "echo ok"})

        self.assertEqual(res.get("exit_code"), 0)
        ev = SandboxEvent.objects.filter(sandbox=self.sandbox, event_type=SandboxEvent.EVENT_SHELL).first()
        self.assertIsNotNone(ev)
        self.assertTrue(ev.success)

        audit = SandboxAuditLog.objects.filter(
            event_type=SandboxAuditLog.EVENT_SHELL_EXEC,
            runtime_id="nr-sandbox-workspace-audit",
        ).first()
        self.assertIsNotNone(audit)
        self.assertEqual(audit.command, "echo ok")
        self.assertEqual(audit.user_email_snapshot, "audit@example.com")
