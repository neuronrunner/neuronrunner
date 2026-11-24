"""OSS-specific unit tests for Docker sandbox runtime, local preview proxy, and self-host defaults."""
from __future__ import annotations

import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from authentication.services.turnstile import verify_turnstile_token
from sandbox.models import Sandbox, Workspace, WorkspaceMembership
from sandbox.services import docker_preview_proxy, docker_sandbox, port_preview, runtime_provider

User = get_user_model()


class OssRuntimeProviderTests(SimpleTestCase):
    def test_runtime_provider_is_always_docker(self):
        self.assertEqual(runtime_provider.sandbox_provider(), "docker")
        self.assertTrue(runtime_provider.uses_docker())
        self.assertFalse(runtime_provider.uses_remote_runtime())

    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_resolve_sandbox_image_prefers_configured_or_falls_back(self, run_mock):
        run_mock.return_value = subprocess.CompletedProcess([], 0, "", "")
        with override_settings(
            DOCKER_SANDBOX_IMAGE="neuronrunner-sandbox:latest",
            DOCKER_SANDBOX_FALLBACK_IMAGE="python:3.11-slim",
        ):
            self.assertEqual(docker_sandbox.resolve_sandbox_image(), "neuronrunner-sandbox:latest")

        run_mock.return_value = subprocess.CompletedProcess([], 1, "", "No such image")
        with override_settings(
            DOCKER_SANDBOX_IMAGE="neuronrunner-sandbox:latest",
            DOCKER_SANDBOX_FALLBACK_IMAGE="python:3.11-slim",
        ):
            self.assertEqual(docker_sandbox.resolve_sandbox_image(), "python:3.11-slim")

    @patch("sandbox.services.docker_sandbox.ensure_docker_sandbox", return_value="nr-sandbox-test")
    @patch("sandbox.services.docker_sandbox.subprocess.Popen")
    def test_local_docker_sandbox_exec_writes_stdin_and_closes_pipe(self, popen_mock, _ensure_mock):
        fake_proc = MagicMock()
        fake_proc.stdin = MagicMock()
        fake_proc.stdout = MagicMock()
        fake_proc.stderr = MagicMock()
        fake_proc.wait.return_value = 0
        popen_mock.return_value = fake_proc

        project = SimpleNamespace(workspace_id="ws-1", user_id="u-1", slug="app", sandbox_cpu=1, sandbox_memory=1024)
        sandbox = docker_sandbox.LocalDockerSandbox(project)
        proc = sandbox.exec("python3", "-c", "pass", stdin=b"hello-bytes")
        self.assertEqual(proc.wait(), 0)
        fake_proc.stdin.write.assert_called_once_with(b"hello-bytes")
        fake_proc.stdin.flush.assert_called_once()
        fake_proc.stdin.close.assert_called_once()
        cmd = popen_mock.call_args.args[0]
        self.assertIn("-i", cmd)


class OssTurnstileSelfHostTests(SimpleTestCase):
    @override_settings(DEBUG=False, TURNSTILE_REQUIRED=False, TURNSTILE_SECRET="")
    def test_turnstile_is_optional_for_self_hosted_production(self):
        req = RequestFactory().post("/auth/login/", REMOTE_ADDR="127.0.0.1")
        ok, err = verify_turnstile_token(req, None, expected_action="login")
        self.assertTrue(ok)
        self.assertIsNone(err)


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    PREVIEW_PROXY_BASE_URL="http://127.0.0.1:8090",
)
class OssPortPreviewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="preview-owner", email="preview@example.com")
        self.workspace = Workspace.objects.create(owner=self.user, name="Preview WS", slug="preview-ws")
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.user, role="owner")
        self.sandbox = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="files",
            filesystem_path="/workspace",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_port_preview_token_issue_and_resolve(self):
        from urllib.parse import parse_qs, urlsplit
        from django.core.cache import cache

        fake_runtime = MagicMock(container_name="nr-sandbox-preview")
        fake_manager = MagicMock()
        fake_manager.get_or_create.return_value = fake_runtime

        with patch("sandbox.services.port_preview.get_sandbox_manager", return_value=fake_manager), patch(
            "sandbox.services.port_preview._listening_ports", return_value=[3000]
        ), patch(
            "sandbox.services.port_preview.get_container_ip", return_value="172.17.0.9"
        ):
            payload = port_preview.create_port_preview(self.sandbox, self.user, 3000, "/dashboard")

        self.assertEqual(payload["port"], 3000)
        self.assertEqual(payload["origin"], "http://127.0.0.1:8090")
        self.assertEqual(payload["path"], "/dashboard")
        parsed = urlsplit(payload["url"])
        self.assertEqual(parsed.path, "/_preview_auth")
        token = parse_qs(parsed.query)["preview_token"][0]
        cached = cache.get(f"{port_preview.PREVIEW_CACHE_PREFIX}{token}")
        self.assertIsNotNone(cached)
        self.assertEqual(cached["container_ip"], "172.17.0.9")
        self.assertEqual(cached["port"], 3000)

        closed = port_preview.close_port_preview(self.sandbox, 3000)
        self.assertTrue(closed["closed"])
        self.assertIsNone(cache.get(f"{port_preview.PREVIEW_CACHE_PREFIX}{token}"))

    def test_config_endpoint_exposes_oss_defaults(self):
        res = self.client.get("/config/")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["sandbox_provider"], "docker")
        self.assertFalse(data["turnstile_required"])
