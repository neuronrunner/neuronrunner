"""MCP OAuth authorization-code + S256 PKCE, discovery and token rotation.

The browser receives authorization URLs and connection status only. Codes are
exchanged by the authenticated completion endpoint; credentials stay encrypted.
"""
import base64
from datetime import timedelta
import hashlib
import secrets
import re
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
from django.conf import settings
from django.db import transaction
from django.urls import reverse
from django.utils import timezone
from rest_framework.exceptions import APIException

from .encryption import decrypt_env_json, encrypt_env_json
from .models import MCPOAuthAttempt, MCPServer
from .oauth_http import oauth_request, public_url

CALLBACK_PATH = '/integrations/oauth/callback'


class OAuthError(APIException):
    status_code = 400

    def __init__(self, message, code='mcp_oauth_failed'):
        super().__init__({'error': message, 'error_code': code})


def _request(method, url, **kwargs):
    try:
        return oauth_request(method, url, **kwargs)
    except (requests.RequestException, ValueError, OSError):
        raise OAuthError('The OAuth server could not be reached securely. Check the server URL and try again.') from None


def _json(response):
    try:
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError
        return data
    except (ValueError, TypeError):
        raise OAuthError('The OAuth server returned an invalid response.') from None


def _https(value):
    try:
        return public_url(value)
    except ValueError:
        raise OAuthError('The provider advertised an invalid OAuth endpoint.') from None


def _origin(value):
    parsed = urlsplit(value)
    return f'{parsed.scheme}://{parsed.netloc}'


def app_origin(request):
    origin = request.headers.get('Origin') or _origin(settings.FRONTEND_BASE_URL)
    allowed = {_origin(settings.FRONTEND_BASE_URL), *getattr(settings, 'CORS_ALLOWED_ORIGINS', [])}
    if origin not in allowed or urlsplit(origin).scheme not in ('https', 'http') or origin != _origin(origin):
        raise OAuthError('This application origin cannot start an MCP connection.')
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' and not (settings.DEBUG and parsed.hostname in ('localhost', '127.0.0.1', 'testserver')):
        raise OAuthError('OAuth requires an HTTPS application URL.')
    return origin


def metadata_url(request):
    base = getattr(settings, 'MCP_OAUTH_PUBLIC_BASE_URL', '').rstrip('/')
    return base + reverse('mcp_oauth_metadata') if base else request.build_absolute_uri(reverse('mcp_oauth_metadata'))


def client_metadata(request):
    origins = {_origin(settings.FRONTEND_BASE_URL), *getattr(settings, 'CORS_ALLOWED_ORIGINS', [])}
    return {
        'client_id': metadata_url(request), 'client_name': 'Neuron Runner',
        'client_uri': settings.FRONTEND_BASE_URL,
        'redirect_uris': sorted(origin + CALLBACK_PATH for origin in origins),
        'grant_types': ['authorization_code', 'refresh_token'],
        'response_types': ['code'], 'token_endpoint_auth_method': 'none',
    }


def _challenge_fields(response):
    # requests' parser handles quoted values containing spaces, commas and escapes.
    challenge = response.headers.get('WWW-Authenticate', '')
    if challenge.lower().startswith('bearer '):
        return requests.utils.parse_dict_header(challenge[7:])
    return {}


def discover_oauth(server_url):
    _https(server_url)
    response = _request('GET', server_url, headers={'Accept': 'application/json, text/event-stream'})
    challenge = _challenge_fields(response)
    parsed = urlsplit(server_url)
    origin = _origin(server_url)
    resource_urls = [challenge['resource_metadata']] if challenge.get('resource_metadata') else list(dict.fromkeys([
        origin + '/.well-known/oauth-protected-resource' + parsed.path.rstrip('/'),
        origin + '/.well-known/oauth-protected-resource',
    ]))
    resource_metadata = None
    for candidate in resource_urls:
        result = _request('GET', _https(candidate), headers={'Accept': 'application/json'})
        if result.status_code == 200:
            resource_metadata = _json(result)
            break
        if result.status_code not in (404, 405):
            raise OAuthError('The provider could not return its OAuth resource metadata.')
    resource = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/'), '', ''))
    if resource_metadata:
        advertised = _https(resource_metadata.get('resource', ''))
        # Resource metadata may describe a parent path, never a different host/audience.
        if _origin(advertised) != origin or not (resource == advertised.rstrip('/') or resource.startswith(advertised.rstrip('/') + '/')):
            raise OAuthError('The OAuth resource does not match this MCP server.')
        resource = advertised
        issuers = resource_metadata.get('authorization_servers')
        if not isinstance(issuers, list) or not issuers:
            raise OAuthError('The MCP server did not advertise an authorization server.')
        issuer = _https(issuers[0]).rstrip('/')
    else:
        # Compatibility with the 2025-03-26 protocol: metadata at the MCP origin.
        issuer = origin
    issuer_parts = urlsplit(issuer)
    issuer_origin = _origin(issuer)
    path = issuer_parts.path.rstrip('/')
    candidates = list(dict.fromkeys([
        issuer_origin + '/.well-known/oauth-authorization-server' + path,
        issuer_origin + '/.well-known/openid-configuration' + path,
        issuer + '/.well-known/openid-configuration',
    ]))
    metadata = None
    for candidate in candidates:
        result = _request('GET', candidate, headers={'Accept': 'application/json'})
        if result.status_code == 200:
            metadata = _json(result)
            break
        if result.status_code not in (404, 405):
            raise OAuthError('The provider could not return its authorization metadata.')
    if not metadata:
        raise OAuthError('This server does not advertise OAuth. Choose API token or no authentication if its provider requires that.', 'mcp_oauth_unavailable')
    if metadata.get('issuer', '').rstrip('/') != issuer:
        raise OAuthError('The OAuth authorization server issuer did not match its metadata.')
    if 'S256' not in metadata.get('code_challenge_methods_supported', []):
        raise OAuthError('This provider does not advertise secure PKCE (S256).')
    for field in ('authorization_endpoint', 'token_endpoint'):
        _https(metadata.get(field, ''))
    scopes = challenge.get('scope')
    if scopes is None:
        supported = (resource_metadata or {}).get('scopes_supported', [])
        if not isinstance(supported, list) or any(not isinstance(scope, str) for scope in supported):
            raise OAuthError('The provider returned invalid OAuth scopes.')
        scopes = ' '.join(supported)
    return {'metadata': metadata, 'resource': resource, 'scope': scopes or '', 'server_url': server_url}


def _client_info(request, config, supplied):
    metadata = config['metadata']
    redirect = config['redirect_uri']
    registered = getattr(settings, 'MCP_OAUTH_CLIENTS', {}).get(config['server_url'], {})
    # Credentials supplied by an operator or the current user always take priority.
    configured = {**registered, **{key: value for key, value in supplied.items() if value}}
    if configured.get('client_id'):
        secret = configured.get('client_secret', '')
        method = configured.get('token_endpoint_auth_method') or ('client_secret_post' if secret else 'none')
        supported = metadata.get('token_endpoint_auth_methods_supported', ['client_secret_basic'])
        if secret and method not in supported and 'client_secret_basic' in supported:
            method = 'client_secret_basic'
        return {'client_id': configured['client_id'], 'client_secret': secret, 'token_endpoint_auth_method': method}
    document_url = metadata_url(request)
    if metadata.get('client_id_metadata_document_supported') and urlsplit(document_url).scheme == 'https':
        return {'client_id': document_url, 'token_endpoint_auth_method': 'none'}
    if not metadata.get('registration_endpoint'):
        raise OAuthError('This provider requires a registered OAuth client. Enter its Client ID in OAuth settings, or configure it on the server.', 'mcp_oauth_client_required')
    registration = {**client_metadata(request), 'redirect_uris': [redirect]}
    registration.pop('client_id')
    if config['scope']:
        registration['scope'] = config['scope']
    result = _request('POST', _https(metadata['registration_endpoint']), json=registration, headers={'Accept': 'application/json'})
    if result.status_code not in (200, 201):
        raise OAuthError('The provider could not register this application. Configure a registered OAuth Client ID in OAuth settings.')
    info = _json(result)
    if not isinstance(info.get('client_id'), str) or not info['client_id']:
        raise OAuthError('The provider did not return an OAuth Client ID.')
    if info.get('redirect_uris') and redirect not in info['redirect_uris']:
        raise OAuthError('The provider registered a different callback URL.')
    method = info.get('token_endpoint_auth_method', 'client_secret_basic')
    if method not in ('none', 'client_secret_basic', 'client_secret_post') or method != 'none' and not info.get('client_secret'):
        raise OAuthError('The provider registered an unsupported OAuth client authentication method.')
    return {key: info[key] for key in ('client_id', 'client_secret', 'token_endpoint_auth_method') if key in info}


def _token_request(config, data):
    client = config['client']
    method = client.get('token_endpoint_auth_method', 'client_secret_basic')
    secret = client.get('client_secret', '')
    kwargs = {}
    if method == 'none':
        data['client_id'] = client['client_id']
    elif method == 'client_secret_post' and secret:
        data.update(client_id=client['client_id'], client_secret=secret)
    elif method == 'client_secret_basic' and secret:
        # RFC 6749 2.3.1 requires form-encoding each Basic credential.
        from urllib.parse import quote_plus
        kwargs['auth'] = (quote_plus(client['client_id']), quote_plus(secret))
    else:
        raise OAuthError('The provider requires an unsupported OAuth client authentication method.')
    result = _request('POST', config['metadata']['token_endpoint'], data=data, headers={'Accept': 'application/json'}, **kwargs)
    if result.status_code != 200:
        error = _json(result).get('error')
        if error == 'invalid_grant':
            raise OAuthError('This authorization has expired or was revoked. Connect your account again.', 'mcp_oauth_reconnect')
        raise OAuthError('The provider rejected the OAuth token request. Connect your account again.')
    token = _json(result)
    if (not isinstance(token.get('access_token'), str) or not token['access_token']
            or str(token.get('token_type', '')).lower() != 'bearer'
            or len(token['access_token']) > 16384
            or not re.fullmatch(r'[A-Za-z0-9._~+/=-]+', token['access_token'])):
        raise OAuthError('The provider did not return a valid Bearer access token.')
    try:
        expires_in = int(token['expires_in']) if 'expires_in' in token else None
        if expires_in is not None and expires_in <= 0:
            raise ValueError
    except (ValueError, TypeError, OverflowError):
        raise OAuthError('The provider returned an invalid token lifetime.') from None
    return {
        'access_token': token['access_token'],
        'refresh_token': token.get('refresh_token'),
        'scope': token.get('scope', config['scope']),
        'expires_at': time.time() + expires_in if expires_in is not None else None,
    }


def start_oauth(server, request):
    if server.transport != 'http' or server.auth_type != 'oauth':
        raise OAuthError('Choose OAuth authentication for a remote MCP server first.')
    origin = app_origin(request)
    config = discover_oauth(server.url)
    config['redirect_uri'] = origin + CALLBACK_PATH
    supplied = {key: request.data.get(key, '') for key in ('client_id', 'client_secret')}
    if any(not isinstance(value, str) or len(value) > 4096 for value in supplied.values()):
        raise OAuthError('Enter a valid OAuth client configuration.')
    config['client'] = _client_info(request, config, supplied)
    state, completion_secret, verifier = (secrets.token_urlsafe(48) for _ in range(3))
    config['verifier'] = verifier
    config['origin'] = origin
    MCPOAuthAttempt.objects.filter(server__user=server.user, expires_at__lt=timezone.now()).delete()
    attempt = MCPOAuthAttempt.objects.create(
        server=server, state_hash=hashlib.sha256(state.encode()).hexdigest(),
        completion_hash=hashlib.sha256(completion_secret.encode()).hexdigest(),
        config_encrypted=encrypt_env_json(config), expires_at=timezone.now() + timedelta(minutes=10),
    )
    params = {
        'response_type': 'code', 'client_id': config['client']['client_id'],
        'redirect_uri': config['redirect_uri'], 'state': state,
        'code_challenge': base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode(),
        'code_challenge_method': 'S256', 'resource': config['resource'],
    }
    if config['scope']:
        params['scope'] = config['scope']
    endpoint = urlsplit(config['metadata']['authorization_endpoint'])
    # Preserve provider-specific parameters, never let them override state/PKCE.
    query = [(key, value) for key, value in parse_qsl(endpoint.query) if key not in params]
    authorization_url = urlunsplit(endpoint._replace(query=urlencode(query + list(params.items()))))
    return {'authorization_url': authorization_url, 'state': state, 'completion_secret': completion_secret,
            'attempt_id': str(attempt.pk), 'redirect_uri': config['redirect_uri']}


def complete_oauth(request):
    state, proof = request.data.get('state', ''), request.data.get('completion_secret', '')
    if not isinstance(state, str) or not isinstance(proof, str) or not state or len(state) > 256 or len(proof) > 256:
        raise OAuthError('This authorization response is invalid. Connect again.')
    with transaction.atomic():
        attempt = MCPOAuthAttempt.objects.select_for_update(of=('self',)).select_related('server').filter(
            state_hash=hashlib.sha256(state.encode()).hexdigest(), server__user=request.user,
        ).first()
        if (not attempt or attempt.consumed or attempt.expires_at <= timezone.now()
                or not secrets.compare_digest(attempt.completion_hash, hashlib.sha256(proof.encode()).hexdigest())):
            raise OAuthError('This authorization expired or has already been used. Connect again.')
        config = decrypt_env_json(attempt.config_encrypted)
        if request.headers.get('Origin') and request.headers['Origin'] != config['origin']:
            raise OAuthError('The authorization response came from a different application.')
        # Consume before exchange: parallel callbacks and failed exchanges cannot replay a code.
        attempt.consumed = True
        attempt.save(update_fields=['consumed'])
    if request.data.get('error'):
        raise OAuthError('Authorization was cancelled or declined. Connect your account again.', 'mcp_oauth_cancelled')
    code = request.data.get('code')
    if not isinstance(code, str) or not code or len(code) > 8192:
        raise OAuthError('The provider did not return an authorization code.')
    issuer = request.data.get('iss')
    metadata = config['metadata']
    if ((issuer and issuer != metadata['issuer'])
            or (metadata.get('authorization_response_iss_parameter_supported') and not issuer)):
        raise OAuthError('The authorization response issuer did not match the selected provider.')
    # Lock also prevents disconnect/configuration changes racing the token exchange.
    with transaction.atomic():
        server = MCPServer.objects.select_for_update().filter(pk=attempt.server_id).first()
        if not server:
            raise OAuthError('This connector was disconnected during authorization.')
        if server.url != config['server_url'] or server.auth_type != 'oauth':
            raise OAuthError('This connector changed during authorization. Connect again.')
        tokens = _token_request(config, {'grant_type': 'authorization_code', 'code': code,
            'redirect_uri': config['redirect_uri'], 'code_verifier': config['verifier'], 'resource': config['resource']})
        config.pop('verifier', None)
        config['tokens'] = tokens
        config['attempt_id'] = str(attempt.pk)
        server.oauth_json = config
        server.enabled = False  # tools/list verification must succeed before activation
        server.save(update_fields=['_oauth_json_encrypted', 'enabled', 'updated_at'])
    return server


def server_headers(server, *, force_refresh=False):
    if server.auth_type != 'oauth':
        return server.headers_json
    with transaction.atomic():
        current = MCPServer.objects.select_for_update().get(pk=server.pk)
        try:
            config = current.oauth_json
        except ValueError:
            raise OAuthError('Connect your account to authorize this MCP server.', 'mcp_oauth_reconnect') from None
        tokens = config.get('tokens', {})
        if current.url != server.url or current.auth_type != 'oauth' or config.get('server_url') != current.url or not tokens.get('access_token'):
            raise OAuthError('Connect your account to authorize this MCP server.', 'mcp_oauth_reconnect')
        if force_refresh or tokens.get('expires_at') is not None and tokens['expires_at'] <= time.time() + 30:
            if not tokens.get('refresh_token'):
                raise OAuthError('Your MCP authorization expired. Connect your account again.', 'mcp_oauth_reconnect')
            refreshed = _token_request(config, {'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token'], 'resource': config['resource']})
            if not refreshed.get('refresh_token'):
                refreshed['refresh_token'] = tokens['refresh_token']
            config['tokens'] = tokens = refreshed
            current.oauth_json = config
            current.save(update_fields=['_oauth_json_encrypted', 'updated_at'])
        headers = {key: value for key, value in current.headers_json.items() if key.lower() != 'authorization'}
        return {**headers, 'Authorization': f"Bearer {tokens['access_token']}"}


def revoke_oauth(server):
    try:
        config = server.oauth_json
    except ValueError:
        return  # Local disconnection still removes unreadable encrypted credentials.
    tokens = config.get('tokens', {})
    endpoint = config.get('metadata', {}).get('revocation_endpoint')
    if endpoint and tokens.get('access_token'):
        try:
            client = config['client']
            data = {'token': tokens.get('refresh_token') or tokens['access_token'], 'client_id': client['client_id']}
            if client.get('client_secret'):
                data['client_secret'] = client['client_secret']
            _request('POST', _https(endpoint), data=data)
        except OAuthError:
            pass  # Local disconnection still removes all encrypted credentials.
