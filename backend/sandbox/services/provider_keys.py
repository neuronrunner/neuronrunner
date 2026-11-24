"""BYOK credentials never leave the backend or go to an arbitrary host."""
import base64

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import APIException

from sandbox.models import WorkspaceProviderKey

PROVIDER_URLS = {
    'openrouter': 'https://openrouter.ai/api/v1',
    'openai': 'https://api.openai.com/v1',
    'deepseek': 'https://api.deepseek.com/v1',
    'groq': 'https://api.groq.com/openai/v1',
    'google': 'https://generativelanguage.googleapis.com/v1beta/openai',
}

BYOS_PROVIDERS = ('anthropic_sub', 'openai_sub', 'antigravity_sub')


def cipher():
    configured = getattr(settings, 'WORKSPACE_KEYS_ENCRYPTION_KEY', '')
    if configured:
        return Fernet(configured.encode())
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=b'neuronrunner-workspace-keys', info=b'byok-v1').derive(settings.SECRET_KEY.encode())
    return Fernet(base64.urlsafe_b64encode(derived))


def decrypt_workspace_provider_secret(workspace_id, provider: str) -> str | None:
    """Return decrypted provider secret/OAuth payload for a workspace provider, or None."""
    if not workspace_id or not provider:
        return None
    key = WorkspaceProviderKey.objects.filter(workspace_id=workspace_id, provider=provider).first()
    if not key or not key.encrypted_key:
        return None
    try:
        return cipher().decrypt(key.encrypted_key.encode()).decode()
    except Exception:
        raise ValueError('Workspace provider key could not be decrypted.') from None


class ProviderKeyRequired(APIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = 'provider_key_required'
    default_detail = 'Add your own provider key or subscription to use this model.'


def configured_providers(workspace) -> set[str]:
    if workspace is None:
        return set()
    return set(WorkspaceProviderKey.objects.filter(workspace=workspace).values_list('provider', flat=True))


def model_uses_workspace_key(model, workspace, providers: set[str] | None = None) -> bool:
    """True when a request for this model would be paid by the workspace's own key."""
    if not getattr(model, 'is_external', False):
        return True
    workspace_id = getattr(workspace, 'pk', None)
    provider = provider_for_model(model, workspace_id=workspace_id)
    if not provider:
        return False
    if providers is None:
        providers = configured_providers(workspace)
    return provider in providers


def model_is_usable(model, workspace, providers: set[str] | None = None) -> bool:
    return model_uses_workspace_key(model, workspace, providers)


def ensure_model_usable(model, workspace) -> None:
    """Every LLM request runs on the workspace's own key or subscription, never a server key."""
    if not model_is_usable(model, workspace):
        raise ProviderKeyRequired()


def workspace_model_credentials(model, workspace):
    """(api_key, base_url, model_id) the workspace's own API key gives for ``model``.

    Returns None when no API key of the workspace covers the model. BYOS
    subscriptions only work through the sandbox CLI, so they return None too.
    """
    if model is None or workspace is None or not getattr(model, 'is_external', False):
        return None
    key = getattr(model, 'provider_key', None)
    if key is not None and key.workspace_id == workspace.pk:
        provider = key.provider
    else:
        provider = provider_for_model(model, workspace_id=workspace.pk)
        if not provider:
            return None
        key = WorkspaceProviderKey.objects.filter(workspace=workspace, provider=provider).first()
    if key is None or provider in BYOS_PROVIDERS:
        return None
    secret = ''
    if key.encrypted_key:
        try:
            secret = cipher().decrypt(key.encrypted_key.encode()).decode()
        except Exception:
            return None
    model_id = getattr(model, 'external_model_id', '') or model.name
    if provider == 'custom':
        base_url = key.base_url or getattr(model, 'external_url', '')
        return (secret or 'none', base_url, model_id) if base_url else None
    if provider not in PROVIDER_URLS or not secret:
        return None
    return secret, PROVIDER_URLS[provider], model_id


def auxiliary_target(workspace, chat_model=None):
    """Credentials for side calls (titles, summaries, memory, suggestions).

    Uses the workspace's auxiliary model, else the chat model, and always the
    workspace's own key. Returns ``{'api_key', 'base_url', 'model'}`` or None when
    no key of the workspace can pay for the call.
    """
    for model in (getattr(workspace, 'auxiliary_model', None), chat_model):
        credentials = workspace_model_credentials(model, workspace)
        if credentials:
            api_key, base_url, model_id = credentials
            return {'api_key': api_key, 'base_url': base_url, 'model': model_id}
    return None


def request_workspace(request):
    """The workspace a read request is about (header or query param), else the personal one."""
    from django.core.exceptions import ValidationError
    from sandbox.models import Workspace
    from sandbox.services.workspace_auth import personal_workspace

    params = getattr(request, 'query_params', {})
    workspace_id = (
        getattr(request, 'headers', {}).get('X-Workspace-ID')
        or params.get('workspace_id')
        or params.get('workspace')
        or params.get('workspace_uuid')
    )
    workspace = None
    if workspace_id:
        try:
            workspace = Workspace.objects.filter(pk=workspace_id, memberships__user=request.user).first()
        except (ValueError, ValidationError):
            workspace = None
    return workspace or personal_workspace(request.user)


def filter_usable_models(queryset, workspace):
    """Drop models no key or subscription of this workspace can pay for."""
    providers = configured_providers(workspace)
    usable_ids = [
        model.pk
        for model in queryset.only('pk', 'is_external', 'provider_name', 'external_url', 'workspace_id')
        if model_uses_workspace_key(model, workspace, providers)
    ]
    return queryset.filter(pk__in=usable_ids)


def provider_for_model(model, workspace_id=None):
    provider_name = getattr(model, 'provider_name', '')
    if provider_name in PROVIDER_URLS or provider_name in BYOS_PROVIDERS or provider_name == 'custom':
        return provider_name
    url = (getattr(model, 'external_url', '') or '').rstrip('/')
    matched = next((provider for provider, trusted_url in PROVIDER_URLS.items() if url == trusted_url), None)
    if matched:
        return matched
    ws_id = workspace_id or getattr(model, 'workspace_id', None)
    if ws_id and url and WorkspaceProviderKey.objects.filter(workspace_id=ws_id, provider='custom').exists():
        return 'custom'
    return None


def credentials_for_request(model, request):
    if request.user_id and not request.workspace.memberships.filter(user_id=request.user_id).exists():
        raise ValueError('Workspace access revoked.')
    if not request.uses_byok:
        return model.external_api_key, model.external_url or None
    
    # Direct provider_key binding on Model takes priority if matched to workspace
    key = getattr(model, 'provider_key', None)
    if not key or key.workspace_id != request.workspace_id:
        provider = provider_for_model(model, workspace_id=request.workspace_id)
        if provider != request.provider or (
            provider not in PROVIDER_URLS and provider not in BYOS_PROVIDERS and provider != 'custom'
        ):
            raise ValueError('Provider configuration changed. Start a new request.')
        key = WorkspaceProviderKey.objects.filter(workspace_id=request.workspace_id, provider=provider).first()
    else:
        provider = key.provider

    if not key:
        raise ValueError('Workspace provider key was removed. Add a key to continue.')
    if provider in BYOS_PROVIDERS:
        if request.user_id and key.created_by_id and key.created_by_id != request.user_id:
            raise ValueError('Personal CLI subscriptions cannot be shared across workspace members. Connect your own subscription.')
        return '', f'byos://{provider}'
    if provider == 'custom':
        secret = ''
        if key.encrypted_key:
            try:
                secret = cipher().decrypt(key.encrypted_key.encode()).decode()
            except Exception:
                raise ValueError('Workspace provider key could not be decrypted.') from None
        endpoint_url = key.base_url or model.external_url
        if not endpoint_url:
            raise ValueError('Custom endpoint base URL is missing.')
        return (secret or 'none'), endpoint_url
    try:
        secret = cipher().decrypt(key.encrypted_key.encode()).decode()
    except Exception:
        raise ValueError('Workspace provider key could not be decrypted.') from None
    return secret, PROVIDER_URLS[provider]
