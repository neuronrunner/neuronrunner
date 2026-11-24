import base64
from datetime import timedelta
import hashlib
import json
import socket
import time
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import requests
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from mcp.encryption import decrypt_env_json
from mcp.models import MCPOAuthAttempt, MCPServer
from mcp.oauth import OAuthError, discover_oauth, server_headers
from mcp.oauth_http import PublicHTTPSConnection, oauth_request

RESOURCE = 'https://mcp.example.com/mcp'
ISSUER = 'https://auth.example.com/tenant'
AUTH_METADATA = {
    'issuer': ISSUER, 'authorization_endpoint': ISSUER + '/authorize',
    'token_endpoint': ISSUER + '/token', 'registration_endpoint': ISSUER + '/register',
    'code_challenge_methods_supported': ['S256'],
    'token_endpoint_auth_methods_supported': ['none', 'client_secret_basic', 'client_secret_post'],
    'authorization_response_iss_parameter_supported': True,
}


def response(status, data=None, headers=None):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(data or {}).encode()
    result.headers.update(headers or {})
    return result


@override_settings(DEBUG=True, SECURE_SSL_REDIRECT=False, FRONTEND_BASE_URL='http://localhost:3000',
                   MCP_OAUTH_PUBLIC_BASE_URL='', MCP_OAUTH_CLIENTS={}, CORS_ALLOWED_ORIGINS=['http://localhost:3000'],
                   CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
                   MCP_URL_VALIDATION_ENABLED=False)
class MCPOAuthTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user(username='oauth-mcp', email='oauth@example.com')
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.server = MCPServer.objects.create(user=self.user, name='test_oauth', transport='http',
            http_transport='streamable-http', url=RESOURCE, auth_type='oauth', enabled=False)
        self.network = patch('mcp.oauth.oauth_request', side_effect=self.provider).start()
        self.addCleanup(patch.stopall)
        self.refresh_rotation = True

    def provider(self, method, url, **kwargs):
        if url == RESOURCE:
            return response(401, headers={'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/resource.json", scope="files:read"'})
        if url == 'https://mcp.example.com/resource.json':
            return response(200, {'resource': RESOURCE, 'authorization_servers': [ISSUER], 'scopes_supported': ['files:read', 'files:write']})
        if url == 'https://auth.example.com/.well-known/oauth-authorization-server/tenant':
            return response(200, AUTH_METADATA)
        if url == ISSUER + '/register':
            return response(201, {'client_id': 'registered-client', 'token_endpoint_auth_method': 'none', 'redirect_uris': ['http://localhost:3000/integrations/oauth/callback']})
        if url == ISSUER + '/token':
            if kwargs['data']['grant_type'] == 'refresh_token':
                return response(200, {'access_token': 'refreshed-private-token', 'token_type': 'Bearer', 'expires_in': 3600,
                                     **({'refresh_token': 'rotated-private-refresh'} if self.refresh_rotation else {})})
            return response(200, {'access_token': 'private-oauth-token', 'refresh_token': 'private-refresh-token', 'token_type': 'Bearer', 'expires_in': 3600})
        return response(404)

    def start(self, **data):
        result = self.client.post(f'/mcp/{self.server.pk}/oauth/start/', data, format='json', HTTP_ORIGIN='http://localhost:3000')
        self.assertEqual(result.status_code, 200, result.data)
        return result.data

    def complete(self, pending, **overrides):
        payload = {'state': pending['state'], 'completion_secret': pending['completion_secret'], 'code': 'authorization-code', 'iss': ISSUER, **overrides}
        with patch('mcp.services.discover_tools', return_value=[{'name': 'search', 'input_schema': {'type': 'object'}}]) as discover:
            result = self.client.post('/mcp/oauth/complete/', payload, format='json', HTTP_ORIGIN='http://localhost:3000')
        return result, discover

    def test_oauth_create_does_not_probe_or_enable_before_authorization(self):
        with patch('mcp.services.discover_tools') as discover:
            result = self.client.post('/mcp/', {'name': 'new', 'transport': 'http', 'url': RESOURCE, 'auth_type': 'oauth'}, format='json')
        self.assertEqual(result.status_code, 201, result.data)
        self.assertFalse(result.data['oauth_connected'])
        self.assertFalse(result.data['enabled'])
        discover.assert_not_called()
        result = self.client.post('/mcp/', {'name': 'new', 'transport': 'http', 'url': RESOURCE, 'auth_type': 'oauth', 'enabled': True}, format='json')
        self.assertEqual(result.status_code, 400)

    def test_pkce_resource_scope_and_client_registration_are_bound_to_attempt(self):
        pending = self.start()
        params = parse_qs(urlsplit(pending['authorization_url']).query)
        attempt = MCPOAuthAttempt.objects.get(pk=pending['attempt_id'])
        config = decrypt_env_json(attempt.config_encrypted)
        self.assertEqual(params['resource'], [RESOURCE])
        self.assertEqual(params['scope'], ['files:read'])  # Challenge wins over advertised broader scopes.
        self.assertEqual(params['code_challenge_method'], ['S256'])
        expected = base64.urlsafe_b64encode(hashlib.sha256(config['verifier'].encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(params['code_challenge'], [expected])
        self.assertNotIn(config['verifier'], pending['authorization_url'])
        self.assertNotIn(pending['completion_secret'], pending['authorization_url'])
        self.assertNotIn(config['verifier'], attempt.config_encrypted)
        registration = next(call.kwargs['json'] for call in self.network.call_args_list if call.args[1] == ISSUER + '/register')
        self.assertEqual(registration['redirect_uris'], ['http://localhost:3000/integrations/oauth/callback'])

    def test_authenticated_callback_encrypts_tokens_and_verifies_before_activation(self):
        pending = self.start()
        result, discover = self.complete(pending)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertTrue(result.data['enabled'])
        self.assertTrue(result.data['oauth_connected'])
        self.assertEqual(discover.call_args.kwargs['headers_json'], {'Authorization': 'Bearer private-oauth-token'})
        self.server.refresh_from_db()
        self.assertNotIn('private-oauth-token', self.server._oauth_json_encrypted)
        self.assertNotIn('private-refresh-token', self.server._oauth_json_encrypted)
        self.assertNotIn('private-', result.content.decode())
        self.assertNotIn('oauth_json', result.data)
        self.assertEqual(self.server.tools.get().name, 'search')
        token_request = next(call.kwargs['data'] for call in self.network.call_args_list if call.args[1] == ISSUER + '/token')
        self.assertEqual(token_request['resource'], RESOURCE)
        self.assertIn('code_verifier', token_request)
        status = self.client.get(f'/mcp/{self.server.pk}/oauth/status/', {'attempt': pending['attempt_id']})
        self.assertEqual(status.data['status'], 'connected')
        self.assertNotIn('private-', status.content.decode())

    def test_attempt_cannot_be_replayed_or_completed_by_another_account(self):
        pending = self.start()
        other = get_user_model().objects.create_user(username='other-oauth', email='other@example.com')
        self.client.force_authenticate(other)
        result, _ = self.complete(pending)
        self.assertEqual(result.status_code, 400)
        self.client.force_authenticate(self.user)
        result, _ = self.complete(pending, completion_secret='wrong-browser-proof')
        self.assertEqual(result.status_code, 400)
        result, _ = self.complete(pending)
        self.assertEqual(result.status_code, 200)
        count = self.network.call_count
        result, _ = self.complete(pending)
        self.assertEqual(result.status_code, 400)
        self.assertEqual(self.network.call_count, count)

    def test_cancelled_expired_and_issuer_mismatch_never_exchange_tokens(self):
        for overrides in ({'error': 'access_denied'}, {'iss': 'https://attacker.example.com'}, {'iss': None}):
            pending = self.start()
            count = sum(call.args[1] == ISSUER + '/token' for call in self.network.call_args_list)
            result, discover = self.complete(pending, **overrides)
            self.assertEqual(result.status_code, 400, result.data)
            discover.assert_not_called()
            self.assertEqual(sum(call.args[1] == ISSUER + '/token' for call in self.network.call_args_list), count)
        pending = self.start()
        MCPOAuthAttempt.objects.filter(pk=pending['attempt_id']).update(expires_at=timezone.now() - timedelta(seconds=1))
        result, _ = self.complete(pending)
        self.assertEqual(result.status_code, 400)
        self.server.refresh_from_db()
        self.assertFalse(self.server.enabled)
        self.assertFalse(self.server._oauth_json_encrypted)

    def test_failed_tool_discovery_stays_disabled(self):
        pending = self.start()
        with patch('mcp.services.discover_tools', side_effect=TimeoutError('MCP verification timed out')):
            result = self.client.post('/mcp/oauth/complete/', {'state': pending['state'], 'completion_secret': pending['completion_secret'], 'code': 'test', 'iss': ISSUER}, format='json')
        self.assertEqual(result.status_code, 400)
        self.server.refresh_from_db()
        self.assertFalse(self.server.enabled)
        self.assertEqual(self.server.tools.count(), 0)

    def authorize(self):
        result, _ = self.complete(self.start())
        self.assertEqual(result.status_code, 200, result.data)
        self.server.refresh_from_db()

    def test_expired_tokens_refresh_and_rotate_without_losing_credentials(self):
        self.authorize()
        config = self.server.oauth_json
        config['tokens']['expires_at'] = time.time() - 10
        self.server.oauth_json = config
        self.server.save()
        headers = server_headers(self.server)
        self.assertEqual(headers, {'Authorization': 'Bearer refreshed-private-token'})
        self.server.refresh_from_db()
        self.assertEqual(self.server.oauth_json['tokens']['refresh_token'], 'rotated-private-refresh')
        self.assertNotIn('refreshed-private-token', self.server._oauth_json_encrypted)
        refreshed_call = self.network.call_args.kwargs['data']
        self.assertEqual(refreshed_call['refresh_token'], 'private-refresh-token')
        self.assertEqual(refreshed_call['resource'], RESOURCE)

    def test_http_401_refreshes_once_and_retries_discovery_with_new_token(self):
        from mcp.services import discover_tools
        self.authorize()
        error = requests.HTTPError(response=response(401))
        tools = [{'name': 'search', 'input_schema': {}}]
        with patch('mcp.services._discover_http', new=Mock(return_value='coroutine')) as discover, patch('mcp.services._run_async', side_effect=[error, tools]):
            result = discover_tools(None, RESOURCE, 'http', headers_json=server_headers(self.server), server_uuid=str(self.server.pk))
        self.assertEqual(result, tools)
        self.assertEqual(discover.call_count, 2)
        self.assertEqual(discover.call_args.args[2]['Authorization'], 'Bearer refreshed-private-token')

    def test_real_sdk_http_401_refreshes_and_retries_with_rotated_token(self):
        import threading
        from http.server import ThreadingHTTPServer
        from mcp.services import discover_tools
        from .test_http_transport import MCPHandler
        observed_headers = []
        class RefreshedTokenHandler(MCPHandler):
            expected_token = 'Bearer refreshed-private-token'
            def do_POST(self):
                observed_headers.append(self.headers.get('Authorization'))
                super().do_POST()
        self.authorize()
        http_server = ThreadingHTTPServer(('127.0.0.1', 0), RefreshedTokenHandler)
        thread = threading.Thread(target=lambda: http_server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        try:
            config = self.server.oauth_json
            self.server.url = f'http://127.0.0.1:{http_server.server_port}/mcp'
            config['server_url'] = self.server.url
            self.server.oauth_json = config
            self.server.save()
            tools = discover_tools(None, self.server.url, 'http', http_transport='streamable-http',
                headers_json=server_headers(self.server), server_uuid=str(self.server.pk))
            self.assertEqual(tools[0]['name'], 'example')
            self.assertEqual(observed_headers[0], 'Bearer private-oauth-token')
            self.assertEqual(observed_headers[1], 'Bearer refreshed-private-token')
            self.assertEqual(self.network.call_args.kwargs['data']['grant_type'], 'refresh_token')
        finally:
            http_server.shutdown()
            http_server.server_close()
            thread.join(timeout=2)

    def test_second_401_does_not_trigger_an_infinite_refresh_loop(self):
        from mcp.services import discover_tools
        self.authorize()
        error = requests.HTTPError(response=response(401))
        with patch('mcp.services._discover_http', new=Mock(return_value='coroutine')), patch('mcp.services._run_async', side_effect=error) as run:
            with self.assertRaises(requests.HTTPError):
                discover_tools(None, RESOURCE, 'http', headers_json=server_headers(self.server), server_uuid=str(self.server.pk))
        self.assertEqual(run.call_count, 2)

    def test_refresh_preserves_original_refresh_token_when_not_rotated(self):
        self.authorize()
        self.refresh_rotation = False
        config = self.server.oauth_json
        config['tokens']['expires_at'] = 1
        self.server.oauth_json = config
        self.server.save()
        server_headers(self.server)
        self.server.refresh_from_db()
        self.assertEqual(self.server.oauth_json['tokens']['refresh_token'], 'private-refresh-token')

    def test_no_refresh_token_requires_reconnect_instead_of_sending_expired_token(self):
        self.authorize()
        config = self.server.oauth_json
        config['tokens'].update(expires_at=1, refresh_token=None)
        self.server.oauth_json = config
        self.server.save()
        with self.assertRaises(OAuthError):
            server_headers(self.server)

    def test_url_changes_invalidate_tokens_tools_and_pending_attempts(self):
        self.authorize()
        pending = self.start()
        with patch('mcp.services.discover_tools') as discover:
            result = self.client.patch(f'/mcp/{self.server.pk}/', {'url': 'https://another.example.com/mcp', 'enabled': True}, format='json')
        self.assertEqual(result.status_code, 200, result.data)
        self.assertFalse(result.data['enabled'])
        self.assertFalse(result.data['oauth_connected'])
        self.server.refresh_from_db()
        self.assertFalse(self.server._oauth_json_encrypted)
        self.assertEqual(self.server.tools.count(), 0)
        discover.assert_not_called()
        result, _ = self.complete(pending)
        self.assertEqual(result.status_code, 400)

    def test_stale_server_instances_cannot_send_another_resources_tokens(self):
        self.authorize()
        stale = MCPServer.objects.get(pk=self.server.pk)
        config = self.server.oauth_json
        config['server_url'] = 'https://new.example.com/mcp'
        self.server.url = config['server_url']
        self.server.oauth_json = config
        self.server.save()
        with self.assertRaises(OAuthError):
            server_headers(stale)

    def test_provider_error_bodies_do_not_leak_credentials(self):
        pending = self.start()
        original = self.provider
        def provider(method, url, **kwargs):
            if url == ISSUER + '/token':
                return response(400, {'error': 'invalid_grant', 'error_description': 'secret private-client-secret access token private-oauth-token'})
            return original(method, url, **kwargs)
        self.network.side_effect = provider
        result, _ = self.complete(pending)
        self.assertEqual(result.status_code, 400)
        self.assertNotIn('private-', result.content.decode())
        self.server.refresh_from_db()
        self.assertFalse(self.server.enabled)

    def test_cimd_and_preregistered_client_credentials(self):
        with override_settings(MCP_OAUTH_PUBLIC_BASE_URL='https://api.neuronrunner.example'), patch.dict(AUTH_METADATA, client_id_metadata_document_supported=True):
            pending = self.start()
        params = parse_qs(urlsplit(pending['authorization_url']).query)
        self.assertEqual(params['client_id'], ['https://api.neuronrunner.example/mcp/oauth/client-metadata.json'])
        self.assertFalse(any(call.args[1] == ISSUER + '/register' for call in self.network.call_args_list))
        self.network.reset_mock()
        pending = self.start(client_id='static-client', client_secret='private-client-secret')
        result, _ = self.complete(pending)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertNotIn('private-client-secret', result.content.decode())
        token_call = next(call for call in self.network.call_args_list if call.args[1] == ISSUER + '/token')
        self.assertEqual(token_call.kwargs['data']['client_secret'], 'private-client-secret')

    def test_owner_and_origin_checks(self):
        result = self.client.post(f'/mcp/{self.server.pk}/oauth/start/', {}, format='json', HTTP_ORIGIN='https://evil.example')
        self.assertEqual(result.status_code, 400)
        self.network.assert_not_called()
        self.client.force_authenticate(None)
        self.assertIn(self.client.post(f'/mcp/{self.server.pk}/oauth/start/').status_code, (401, 403))

    def test_public_metadata_never_contains_credentials(self):
        self.client.force_authenticate(None)
        result = self.client.get('/mcp/oauth/client-metadata.json')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['client_name'], 'Neuron Runner')
        self.assertNotIn('secret', result.content.decode())

    def test_missing_client_registration_has_actionable_error(self):
        with patch.dict(AUTH_METADATA, registration_endpoint=None):
            result = self.client.post(f'/mcp/{self.server.pk}/oauth/start/', {}, format='json')
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.data['error_code'], 'mcp_oauth_client_required')

    def test_disconnect_removes_encrypted_tokens_and_attempts(self):
        self.authorize()
        result = self.client.delete(f'/mcp/{self.server.pk}/')
        self.assertEqual(result.status_code, 200)
        self.assertFalse(MCPServer.objects.filter(pk=self.server.pk).exists())
        self.assertEqual(MCPOAuthAttempt.objects.count(), 0)

    def test_mismatched_resource_or_issuer_and_missing_pkce_are_rejected(self):
        original = self.provider
        for field, invalid in [('resource', 'https://attacker.example/mcp'), ('issuer', 'https://attacker.example'), ('code_challenge_methods_supported', ['plain'])]:
            def provider(method, url, **kwargs):
                result = original(method, url, **kwargs)
                data = result.json()
                if field == 'resource' and url.endswith('resource.json') or field != 'resource' and '/.well-known/oauth-authorization-server' in url:
                    data[field] = invalid
                return response(result.status_code, data, dict(result.headers))
            self.network.side_effect = provider
            with self.assertRaises(OAuthError):
                discover_oauth(RESOURCE)

    def test_undecryptable_oauth_tokens_fail_closed_without_crashing(self):
        self.authorize()
        with override_settings(SECRET_KEY='rotated-secret-key'):
            list_result = self.client.get('/mcp/')
            self.assertEqual(list_result.status_code, 200)
            self.assertFalse(list_result.data[0]['oauth_connected'])

            enable_result = self.client.patch(f'/mcp/{self.server.pk}/', {'enabled': True}, format='json')
            self.assertEqual(enable_result.status_code, 400)

            with self.assertRaises(OAuthError):
                server_headers(self.server)

            delete_result = self.client.delete(f'/mcp/{self.server.pk}/')
            self.assertEqual(delete_result.status_code, 200)
        self.assertFalse(MCPServer.objects.filter(pk=self.server.pk).exists())


class OAuthNetworkTests(SimpleTestCase):
    def test_unsafe_schemes_and_credentials_are_blocked_before_network(self):
        for url in ['http://example.com/mcp', 'file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com:8080/token']:
            with self.subTest(url=url), patch('mcp.oauth_http.requests.Session') as session:
                with self.assertRaises(ValueError):
                    oauth_request('POST', url)
                session.assert_not_called()

    def test_private_and_mixed_dns_answers_are_never_connected(self):
        for ips in [['127.0.0.1'], ['169.254.169.254'], ['::1'], ['93.184.216.34', '10.0.0.1']]:
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443)) for ip in ips]
            with self.subTest(ips=ips), patch('mcp.oauth_http.socket.getaddrinfo', return_value=answers), patch('mcp.oauth_http.socket.socket') as connect:
                with self.assertRaises(ValueError):
                    PublicHTTPSConnection('example.com')._new_conn()
                connect.assert_not_called()

    def test_token_request_redirects_are_never_followed(self):
        with patch('mcp.oauth_http.requests.Session') as session:
            result = session.return_value.__enter__.return_value.request.return_value.__enter__.return_value
            result.status_code = 302
            with self.assertRaises(ValueError):
                oauth_request('POST', 'https://example.com/token', data={'code': 'private-code'})
            self.assertFalse(session.return_value.__enter__.return_value.request.call_args.kwargs['allow_redirects'])
