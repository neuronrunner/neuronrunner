import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from mcp.models import MCPServer, MCPServerTool
from mcp.services import _discover_http, _http_transport


@override_settings(
    SECURE_SSL_REDIRECT=False,
    CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
    REMOTE_ONLY_MCP=False,
    MCP_URL_VALIDATION_ENABLED=False,
)
class ConnectorAPITests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='connectors', email='connectors@example.com')
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def create_remote(self):
        with patch('mcp.services.discover_tools', return_value=[]) as discover:
            response = self.client.post('/mcp/', {
                'name': 'github', 'transport': 'http', 'http_transport': 'streamable-http',
                'url': 'https://example.com/mcp', 'enabled': False,
                'headers_json': {'Authorization': 'Bearer private-test-token'},
            }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(discover.call_args.kwargs['http_transport'], 'streamable-http')
        self.assertEqual(discover.call_args.kwargs['headers_json'], {'Authorization': 'Bearer private-test-token'})
        return MCPServer.objects.get(uuid=response.data['uuid'])

    def test_headers_are_encrypted_and_never_returned_by_api(self):
        server = self.create_remote()
        self.assertNotIn('private-test-token', server._headers_json_encrypted)
        self.assertEqual(server.headers_json['Authorization'], 'Bearer private-test-token')
        response = self.client.get('/mcp/')
        self.assertNotIn('private-test-token', response.content.decode())
        self.assertNotIn('headers_json', response.data[0])
        self.assertTrue(response.data[0]['has_headers'])

    def test_activation_patch_preserves_remote_configuration_and_credentials(self):
        server = self.create_remote()
        with patch('mcp.services.discover_tools') as discover:
            response = self.client.patch(f'/mcp/{server.uuid}/', {'enabled': True}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        discover.assert_not_called()
        server.refresh_from_db()
        self.assertTrue(server.enabled)
        self.assertEqual(server.url, 'https://example.com/mcp')
        self.assertEqual(server.headers_json, {'Authorization': 'Bearer private-test-token'})

    def test_successful_verification_synchronizes_tools_before_activation(self):
        server = self.create_remote()
        MCPServerTool.objects.create(server=server, name='old_tool')
        with patch('mcp.views.discover_tools', return_value=[{'name': 'new_tool', 'input_schema': {'type': 'object'}}]) as discover:
            response = self.client.post(f'/mcp/{server.uuid}/test/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['tool_count'], 1)
        self.assertEqual(discover.call_args.kwargs['headers_json'], server.headers_json)
        self.assertEqual(list(server.tools.values_list('name', flat=True)), ['new_tool'])
        server.refresh_from_db()
        self.assertFalse(server.enabled)

    def test_failed_verification_does_not_activate_or_remove_tools(self):
        server = self.create_remote()
        MCPServerTool.objects.create(server=server, name='existing_tool')
        with patch('mcp.views.discover_tools', side_effect=TimeoutError):
            response = self.client.post(f'/mcp/{server.uuid}/test/')
        self.assertEqual(response.status_code, 504)
        server.refresh_from_db()
        self.assertFalse(server.enabled)
        self.assertEqual(server.tools.count(), 1)

    def test_servers_are_private_to_their_owner(self):
        server = self.create_remote()
        other = get_user_model().objects.create_user(username='other-connector', email='other@example.com')
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get('/mcp/').data, [])
        self.assertEqual(self.client.post(f'/mcp/{server.uuid}/test/').status_code, 404)
        self.assertEqual(self.client.delete(f'/mcp/{server.uuid}/').status_code, 404)

    def test_legacy_sse_is_default_and_stdio_secrets_are_write_only(self):
        from sandbox.services.sandbox_service import SandboxBootstrapService
        workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        with patch('mcp.services.discover_tools', return_value=[]):
            response = self.client.post('/mcp/', {'name': 'local', 'transport': 'stdio', 'workspace': str(workspace.pk), 'command': 'npx -y example', 'env_json': {'API_KEY': 'private-local-key'}}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data['http_transport'], 'sse')
        self.assertTrue(response.data['has_environment'])
        self.assertNotIn('env_json', response.data)
        self.assertNotIn('private-local-key', response.content.decode())


class ConnectorTransportTests(SimpleTestCase):
    def test_streamable_http_passes_headers_with_sdk_1_and_sdk_2_streams(self):
        for stream_values in [('read', 'write'), ('read', 'write', 'session-id')]:
            with self.subTest(stream_count=len(stream_values)):
                http_client = SimpleNamespace(event_hooks={'response': []})
                @asynccontextmanager
                async def client_context():
                    yield http_client

                @asynccontextmanager
                async def transport_context(*args, **kwargs):
                    yield stream_values

                async def check():
                    async with _http_transport('https://example.com/mcp', 'streamable-http', {'Authorization': 'Bearer secret'}) as streams:
                        self.assertEqual(streams, ('read', 'write'))

                with patch('mcp.shared._httpx_utils.create_mcp_http_client', return_value=client_context()) as client, patch('mcp.client.streamable_http.streamable_http_client', side_effect=transport_context) as transport:
                    asyncio.run(check())
                client.assert_called_once_with(headers={'Authorization': 'Bearer secret'})
                transport.assert_called_once_with('https://example.com/mcp', http_client=http_client)

    def test_sse_passes_headers_without_changing_legacy_protocol(self):
        @asynccontextmanager
        async def transport_context(*args, **kwargs):
            yield 'read', 'write'

        async def check():
            async with _http_transport('https://example.com/sse', 'sse', {'X-API-Key': 'secret'}) as streams:
                self.assertEqual(streams, ('read', 'write'))

        with patch('mcp.client.sse.sse_client', side_effect=transport_context) as transport:
            asyncio.run(check())
        transport.assert_called_once_with('https://example.com/sse', headers={'X-API-Key': 'secret'})

    def test_discovery_initializes_session_and_reads_tools(self):
        @asynccontextmanager
        async def transport_context(*args):
            yield 'read', 'write'

        session = AsyncMock()
        session.list_tools.return_value = SimpleNamespace(tools=[SimpleNamespace(name='search', description='Search', inputSchema={'type': 'object'})])
        session.__aenter__.return_value = session
        with patch('mcp.services._http_transport', side_effect=transport_context), patch('mcp.client.session.ClientSession', return_value=session):
            result = asyncio.run(_discover_http('https://example.com/mcp', 'streamable-http', {}))
        session.initialize.assert_awaited_once()
        self.assertEqual(result, [{'name': 'search', 'description': 'Search', 'input_schema': {'type': 'object'}}])
