import asyncio
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from mcp.url_security import UnsafeMCPURL, validate_mcp_url
from sandbox.services.sandbox_service import SandboxBootstrapService


def public_addresses(*_args, **_kwargs):
    return [(2, 1, 6, "", ("93.184.216.34", 443))]


def private_addresses(*_args, **_kwargs):
    return [(2, 1, 6, "", ("10.0.0.8", 443))]


@override_settings(MCP_URL_VALIDATION_ENABLED=True, MCP_ALLOW_PRIVATE_URLS=False)
class MCPURLSecurityTests(SimpleTestCase):
    def test_public_https_url_is_accepted(self):
        with patch("mcp.url_security.socket.getaddrinfo", side_effect=public_addresses):
            self.assertEqual(validate_mcp_url("https://example.com/mcp"), "https://example.com/mcp")

    def test_non_https_credentials_fragments_and_custom_ports_are_rejected(self):
        for url in (
            "http://example.com/mcp",
            "https://user:pass@example.com/mcp",
            "https://example.com/mcp#fragment",
            "https://example.com:8443/mcp",
            "https://example.com/{tenant}/mcp",
            "not-a-url",
        ):
            with self.subTest(url=url), self.assertRaises(UnsafeMCPURL):
                validate_mcp_url(url)

    def test_private_loopback_link_local_and_resolution_failures_are_rejected(self):
        cases = [
            "https://127.0.0.1/mcp",
            "https://10.0.0.8/mcp",
            "https://169.254.169.254/latest/meta-data",
            "https://localhost/mcp",
        ]
        for url in cases:
            with self.subTest(url=url), patch("mcp.url_security.socket.getaddrinfo", side_effect=private_addresses), self.assertRaises(UnsafeMCPURL):
                validate_mcp_url(url)
        with patch("mcp.url_security.socket.getaddrinfo", side_effect=OSError("dns down")), self.assertRaises(UnsafeMCPURL):
            validate_mcp_url("https://example.com/mcp")

    @override_settings(MCP_ALLOW_PRIVATE_URLS=True)
    def test_private_urls_can_be_allowed_explicitly_for_self_hosted_servers(self):
        self.assertEqual(validate_mcp_url("https://127.0.0.1/mcp"), "https://127.0.0.1/mcp")

    @override_settings(MCP_URL_VALIDATION_ENABLED=False)
    def test_validation_can_be_disabled_for_local_development(self):
        self.assertEqual(validate_mcp_url("http://127.0.0.1:8931/mcp"), "http://127.0.0.1:8931/mcp")

    def test_http_transport_revalidates_before_connecting(self):
        from mcp.services import _http_transport

        async def enter_transport():
            async with _http_transport("https://127.0.0.1/mcp", "sse", {}):
                pass

        with self.assertRaises(UnsafeMCPURL):
            asyncio.run(enter_transport())


@override_settings(SECURE_SSL_REDIRECT=False, CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class RemoteOnlyMCPTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="remote-policy", email="remote-policy@example.com")
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_new_stdio_connectors_are_rejected_by_default(self):
        response = self.client.post(
            "/mcp/",
            {"name": "local", "transport": "stdio", "command": "npx -y example", "workspace": str(self.workspace.pk), "enabled": False},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("transport", response.json())

    @override_settings(REMOTE_ONLY_MCP=False)
    def test_stdio_connectors_remain_available_when_policy_is_disabled(self):
        response = self.client.post(
            "/mcp/",
            {"name": "local", "transport": "stdio", "command": "npx -y example", "workspace": str(self.workspace.pk), "enabled": False},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.json())

    def test_remote_connector_rejects_private_or_non_https_urls(self):
        for url in ("http://127.0.0.1/mcp", "https://127.0.0.1/mcp", "https://169.254.169.254/latest/meta-data"):
            with self.subTest(url=url):
                response = self.client.post(
                    "/mcp/",
                    {"name": "remote", "transport": "http", "url": url, "enabled": False},
                    format="json",
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn("url", response.json())

    def test_remote_connector_accepts_a_public_https_endpoint(self):
        with patch("mcp.url_security.socket.getaddrinfo", side_effect=public_addresses), \
                patch("mcp.services.discover_tools", return_value=[]):
            response = self.client.post(
                "/mcp/",
                {"name": "remote", "transport": "http", "url": "https://example.com/mcp", "enabled": False},
                format="json",
            )
        self.assertEqual(response.status_code, 201, response.json())

    @override_settings(MCP_ALLOW_PRIVATE_URLS=True)
    @patch("mcp.services.discover_tools", return_value=[])
    def test_private_remote_urls_can_be_enabled_for_self_hosted_servers(self, _discover):
        response = self.client.post(
            "/mcp/",
            {"name": "remote", "transport": "http", "url": "https://127.0.0.1/mcp", "enabled": False},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.json())
