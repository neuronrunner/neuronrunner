import asyncio
import threading
from unittest.mock import AsyncMock, MagicMock, patch

from channels.routing import URLRouter
from channels.security.websocket import OriginValidator
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.core import signing
from django.core.cache import cache
from django.test import TransactionTestCase, override_settings
from django.urls import re_path
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from sandbox.consumers import TerminalConsumer, WS_RUNTIME_UNAVAILABLE
from sandbox.models import Sandbox, Workspace, WorkspaceMembership
from sandbox.ws_security import issue_ticket, consume_ticket


@override_settings(DEBUG=True, CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}, SANDBOX_PROVIDER="docker")
class TerminalSecurityTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user(username="terminal-member", email="member@example.com", password="test-pass")
        self.owner = get_user_model().objects.create_user(username="terminal-owner", email="owner@example.com")
        self.workspace = Workspace.objects.create(owner=self.owner, name="Private", slug="private", storage_key="terminal-security")
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.user, role="member")
        self.project = Sandbox.objects.create(user=self.user, workspace=self.workspace, slug="code", filesystem_path="/workspace/code")
        self.access = AccessToken.for_user(self.user)
        self.app = OriginValidator(URLRouter([
            re_path(r"^ws/sandbox/terminal/(?P<sandbox_uuid>[a-zA-Z0-9_-]+)/$", TerminalConsumer.as_asgi()),
        ]), ["https://app.example.com"])
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {self.access}")

    def ticket(self):
        return issue_ticket(self.user, self.project.uuid, self.access)

    def socket(self, suffix="", origin=b"https://app.example.com"):
        return WebsocketCommunicator(self.app, f"/ws/sandbox/terminal/{self.project.uuid}/{suffix}", headers=[(b"origin", origin)])

    def test_ticket_endpoint_checks_membership_and_hides_runtime_secrets(self):
        response = self.client.post(f"/sandbox/sandboxes/{self.project.uuid}/terminal-ticket/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "no-store")
        consume_ticket(response.json()["ticket"], self.project.uuid)
        with self.assertRaises(signing.BadSignature):
            consume_ticket(response.json()["ticket"], self.project.uuid)
        response = self.client.get(f"/sandbox/sandboxes/{self.project.uuid}/")
        self.assertNotIn("terminal_token", response.json())
        self.assertNotIn("terminal_url", response.json())
        WorkspaceMembership.objects.filter(workspace=self.workspace, user=self.user).delete()
        self.assertEqual(self.client.post(f"/sandbox/sandboxes/{self.project.uuid}/terminal-ticket/").status_code, 404)

    def test_refresh_token_cannot_issue_ticket(self):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(self.user)}")
        self.assertEqual(self.client.post(f"/sandbox/sandboxes/{self.project.uuid}/terminal-ticket/").status_code, 401)

    def test_wrong_origin_and_jwt_in_query_are_rejected(self):
        async def run():
            for socket in (self.socket(origin=b"https://evil.example.com"), self.socket(f"?token={self.access}")):
                self.assertFalse((await socket.connect())[0])
                await socket.disconnect()
        asyncio.run(run())

    def test_input_before_authentication_never_starts_runtime(self):
        async def run():
            socket = self.socket()
            self.assertTrue((await socket.connect())[0])
            await socket.send_json_to({"type": "input", "data": "echo unsafe"})
            self.assertEqual((await socket.receive_output())["code"], 4001)
            await socket.disconnect()
        with patch.object(TerminalConsumer, "_start_terminal", new_callable=AsyncMock) as start:
            asyncio.run(run())
            start.assert_not_called()

    def test_expired_tampered_and_cross_resource_tickets_are_rejected(self):
        ticket = self.ticket()
        with patch("sandbox.ws_security.TICKET_TTL", -1):
            with self.assertRaises(signing.SignatureExpired):
                consume_ticket(ticket, self.project.uuid)
        for value, resource in ((ticket + "tampered", self.project.uuid), (ticket, "other-project")):
            with self.assertRaises(signing.BadSignature):
                consume_ticket(value, resource)

    def test_valid_ticket_connects_but_replay_is_rejected(self):
        ticket = self.ticket()
        async def run():
            first, second = self.socket(), self.socket()
            self.assertTrue((await first.connect())[0])
            await first.send_json_to({"type": "auth", "ticket": ticket})
            await asyncio.sleep(0.05)
            self.assertTrue((await second.connect())[0])
            await second.send_json_to({"type": "auth", "ticket": ticket})
            self.assertEqual((await second.receive_output())["code"], 4001)
            await first.disconnect()
            await second.disconnect()
        with patch.object(TerminalConsumer, "_start_terminal", new_callable=AsyncMock) as start:
            asyncio.run(run())
            start.assert_awaited_once()

    def test_removing_connected_creator_revokes_access(self):
        ticket = self.ticket()
        async def run():
            from asgiref.sync import sync_to_async
            socket = self.socket()
            self.assertTrue((await socket.connect())[0])
            await socket.send_json_to({"type": "auth", "ticket": ticket})
            await asyncio.sleep(0.05)
            await sync_to_async(WorkspaceMembership.objects.filter(workspace=self.workspace, user=self.user).delete)()
            await socket.send_json_to({"type": "resize", "cols": 80, "rows": 24})
            self.assertEqual((await socket.receive_output())["code"], 4003)
            await socket.disconnect()
        with patch.object(TerminalConsumer, "_start_terminal", new_callable=AsyncMock):
            asyncio.run(run())

    def test_runtime_failure_reports_error_and_closes(self):
        ticket = self.ticket()
        async def run():
            socket = self.socket()
            self.assertTrue((await socket.connect())[0])
            await socket.send_json_to({"type": "auth", "ticket": ticket})
            self.assertEqual((await socket.receive_json_from())["type"], "error")
            self.assertEqual((await socket.receive_output())["code"], WS_RUNTIME_UNAVAILABLE)
            await socket.disconnect()
        with patch("sandbox.services.docker_sandbox.ensure_docker_sandbox", side_effect=RuntimeError("docker offline")):
            asyncio.run(run())

    def test_runtime_failure_closes_with_a_code_accepted_by_real_autobahn(self):
        from autobahn.websocket.protocol import WebSocketProtocol
        protocol = WebSocketProtocol()
        with patch.object(protocol, 'sendCloseFrame') as close_frame:
            protocol.sendClose(WS_RUNTIME_UNAVAILABLE)
            close_frame.assert_called_once()

    def test_one_startup_failure_emits_only_one_error_and_one_close(self):
        ticket = self.ticket()

        async def fail_twice(consumer):
            await consumer._runtime_failure('Provider unavailable')
            await consumer._runtime_failure('Duplicate error')

        async def run():
            socket = self.socket()
            self.assertTrue((await socket.connect())[0])
            await socket.send_json_to({'type':'auth','ticket':ticket})
            self.assertEqual((await socket.receive_json_from())['data'], 'Provider unavailable')
            self.assertEqual((await socket.receive_output())['code'], WS_RUNTIME_UNAVAILABLE)
            self.assertTrue(await socket.receive_nothing(timeout=0.05))
            await socket.disconnect()

        with patch.object(TerminalConsumer, '_start_terminal', fail_twice):
            asyncio.run(run())

    def test_slow_runtime_startup_does_not_block_another_connections_ticket_validation(self):
        first_ticket, second_ticket = self.ticket(), self.ticket()
        entered, release = threading.Event(), threading.Event()

        def start(project):
            entered.set()
            release.wait(3)
            raise RuntimeError('Docker unavailable')

        async def run():
            first, second = self.socket(), self.socket()
            try:
                self.assertTrue((await first.connect())[0])
                await first.send_json_to({'type': 'auth', 'ticket': first_ticket})
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                self.assertTrue((await second.connect())[0])
                with patch.object(TerminalConsumer, '_start_terminal', new_callable=AsyncMock) as second_start:
                    await second.send_json_to({'type': 'auth', 'ticket': second_ticket})
                    for _ in range(100):
                        if second_start.await_count:
                            break
                        await asyncio.sleep(0.005)
                    second_start.assert_awaited_once()
                self.assertFalse(release.is_set())
                release.set()
                self.assertEqual((await first.receive_json_from())['code'], 'runtime_unavailable')
                self.assertEqual((await first.receive_output())['code'], WS_RUNTIME_UNAVAILABLE)
            finally:
                release.set()
                await first.disconnect()
                await second.disconnect()

        with patch('sandbox.services.docker_sandbox.ensure_docker_sandbox', side_effect=start), patch('sandbox.consumers.WS_AUTH_TIMEOUT', 0.7):
            asyncio.run(run())

    def test_post_authentication_startup_exception_is_not_reported_as_an_invalid_ticket(self):
        ticket = self.ticket()

        async def run():
            socket = self.socket()
            self.assertTrue((await socket.connect())[0])
            await socket.send_json_to({'type': 'auth', 'ticket': ticket})
            error = await socket.receive_json_from()
            self.assertEqual(error['code'], 'runtime_unavailable')
            self.assertEqual((await socket.receive_output())['code'], WS_RUNTIME_UNAVAILABLE)
            await socket.disconnect()

        with patch.object(TerminalConsumer, '_start_terminal', new_callable=AsyncMock, side_effect=RuntimeError('Provider unavailable')):
            asyncio.run(run())

    def test_ticket_store_outage_is_a_service_error_instead_of_session_expiry(self):
        ticket = self.ticket()

        async def run():
            socket = self.socket()
            self.assertTrue((await socket.connect())[0])
            await socket.send_json_to({'type': 'auth', 'ticket': ticket})
            self.assertEqual((await socket.receive_json_from())['code'], 'runtime_unavailable')
            self.assertEqual((await socket.receive_output())['code'], WS_RUNTIME_UNAVAILABLE)
            await socket.disconnect()

        with patch('sandbox.ws_security.cache') as storage, patch.object(TerminalConsumer, '_start_terminal', new_callable=AsyncMock) as start:
            storage.add.side_effect = ConnectionError('Cache unavailable')
            asyncio.run(run())
            start.assert_not_called()

    def test_production_without_shared_ticket_store_fails_closed(self):
        with override_settings(DEBUG=False):
            response = self.client.post(f"/sandbox/sandboxes/{self.project.uuid}/terminal-ticket/")
        self.assertEqual(response.status_code, 503)

    def test_unauthed_connection_times_out(self):
        async def run():
            socket = self.socket()
            self.assertTrue((await socket.connect())[0])
            self.assertEqual((await socket.receive_output())["code"], 4001)
            await socket.disconnect()
        with patch("sandbox.consumers.WS_AUTH_TIMEOUT", 0.01):
            asyncio.run(run())

    def test_disabled_users_password_changes_and_expired_sessions_are_rejected(self):
        from sandbox.ws_security import ticket_user
        payload = consume_ticket(self.ticket(), self.project.uuid)
        self.assertIsNotNone(ticket_user(payload))
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertIsNone(ticket_user(payload))
        self.user.is_active = True
        self.user.set_password("changed")
        self.user.save(update_fields=["is_active", "password"])
        self.assertIsNone(ticket_user(payload))
        payload = consume_ticket(self.ticket(), self.project.uuid)
        payload["session_exp"] = 0
        self.assertIsNone(ticket_user(payload))

    def test_ticket_store_outage_cannot_authorize_terminal(self):
        ticket = self.ticket()
        with patch("sandbox.ws_security.cache.add", side_effect=ConnectionError("offline")):
            with self.assertRaises(ConnectionError):
                consume_ticket(ticket, self.project.uuid)

    def test_request_status_authenticates_in_first_message_and_rejects_refresh(self):
        from sandbox.consumers import RequestStatusConsumer
        app = URLRouter([re_path(r"^ws/chat/request/(?P<request_uuid>[a-zA-Z0-9_-]+)/$", RequestStatusConsumer.as_asgi())])
        async def run():
            for token, valid in ((str(self.access), True), (str(RefreshToken.for_user(self.user)), False)):
                socket = WebsocketCommunicator(app, "/ws/chat/request/test/")
                self.assertTrue((await socket.connect())[0])
                await socket.send_json_to({"type": "auth", "token": token})
                if valid:
                    self.assertEqual((await socket.receive_json_from())["type"], "request_update")
                else:
                    self.assertEqual((await socket.receive_output())["code"], 4001)
                await socket.disconnect()
        with patch.object(RequestStatusConsumer, "_get_request_user_id", new_callable=AsyncMock, return_value=self.user.pk), patch.object(RequestStatusConsumer, "_get_serialized_request", new_callable=AsyncMock, return_value={"status": "processing"}):
            asyncio.run(run())

    def test_member_removal_stops_shared_runtime_before_revoking_access(self):
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.owner, role="owner")
        self.project.sandbox_object_id = "sb-test"
        self.project.save(update_fields=["sandbox_object_id"])
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(self.owner)}")
        with patch("sandbox.services.sandbox_session.get_sandbox_manager") as manager:
            response = self.client.delete(f"/sandbox/workspaces/{self.workspace.uuid}/members/{self.user.uuid}/")
        self.assertEqual(response.status_code, 204)
        manager.return_value.close_session_immediately.assert_called_once()
        self.assertFalse(WorkspaceMembership.objects.filter(workspace=self.workspace, user=self.user).exists())
