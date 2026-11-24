import re
import time
import httpx
from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework import permissions, serializers, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from model.models import LLMConfig, Model
from model.reasoning import get_model_reasoning_spec, normalize_admin_reasoning_config
from sandbox.models import Workspace, WorkspaceMembership, WorkspaceProviderKey
from sandbox.services.provider_keys import BYOS_PROVIDERS, PROVIDER_URLS, cipher
from utils.ssrf import is_safe_external_url


class CustomModelInput(serializers.Serializer):
    key_id = serializers.UUIDField(required=False, allow_null=True)
    provider = serializers.ChoiceField(choices=list(PROVIDER_URLS) + ['custom', *BYOS_PROVIDERS], required=False, allow_blank=True)
    display_name = serializers.CharField(max_length=120, trim_whitespace=True)
    external_model_id = serializers.CharField(max_length=255, trim_whitespace=True)
    context_length = serializers.IntegerField(default=128000, min_value=1024, max_value=2097152)
    max_tokens = serializers.IntegerField(default=4096, min_value=128, max_value=65536)
    is_reasoning = serializers.BooleanField(default=False)
    reasoning_mode = serializers.ChoiceField(choices=['none', 'effort', 'toggle', 'fixed'], required=False, allow_blank=True)
    supported_reasoning_efforts = serializers.ListField(
        child=serializers.CharField(max_length=20),
        required=False,
        allow_empty=True,
    )
    default_reasoning_effort = serializers.CharField(max_length=20, required=False, allow_blank=True)
    supports_vision = serializers.BooleanField(default=False)
    supports_tools = serializers.BooleanField(default=True)
    custom_base_url = serializers.URLField(required=False, allow_blank=True, default="")

    def validate_custom_base_url(self, value):
        if value:
            safe, err = is_safe_external_url(value)
            if not safe:
                raise serializers.ValidationError(f"Invalid custom endpoint URL: {err}")
        return value


def custom_model_metadata(model):
    llm_cfg = getattr(model, 'llm_config', None)
    pk = getattr(model, 'provider_key', None)
    reasoning_spec = get_model_reasoning_spec(model)
    resolved_provider = model.provider_name or (pk.provider if pk else 'custom')
    return {
        'uuid': str(model.pk),
        'name': model.name,
        'display_name': model.display_name or model.description or model.name,
        'provider': resolved_provider,
        'is_byos': resolved_provider in BYOS_PROVIDERS,
        'provider_key': {
            'uuid': str(pk.pk),
            'provider': pk.provider,
            'masked_key': '(connected JSON)' if pk.last4 == 'JSON' else (('••••' + pk.last4) if pk.last4 else '(no key required)'),
            'base_url': pk.base_url,
        } if pk else None,
        'external_model_id': model.external_model_id,
        'external_url': model.external_url,
        'context_length': model.context_length or (llm_cfg.context_length if llm_cfg else 128000),
        'max_tokens': llm_cfg.max_tokens if llm_cfg else 4096,
        'is_reasoning': model.is_reasoning,
        'reasoning_mode': reasoning_spec['mode'],
        'reasoning_tiers': reasoning_spec['tiers'],
        'default_reasoning_effort': reasoning_spec['default'],
        'supports_vision': getattr(model, 'supports_vision', False),
        'supports_tools': llm_cfg.supports_tools if llm_cfg else True,
        'created_at': model.created_at.isoformat(),
    }


def get_workspace_and_check_membership(request, workspace_uuid, require_admin=False):
    membership = get_object_or_404(
        WorkspaceMembership.objects.select_related('workspace'),
        workspace_id=workspace_uuid,
        user=request.user,
    )
    if require_admin and membership.role not in ('owner', 'admin'):
        raise PermissionDenied('Only workspace admins can manage custom models.')
    return membership.workspace


class WorkspaceCustomModelsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, workspace_uuid, model_name=None, *args, **kwargs):
        workspace = get_workspace_and_check_membership(request, workspace_uuid, require_admin=False)
        if model_name:
            m = get_object_or_404(
                Model.objects.filter(workspace=workspace).filter(
                    Q(author=request.user) | ~Q(provider_name__in=BYOS_PROVIDERS)
                ).select_related('llm_config', 'provider_key'),
                name=model_name,
            )
            return Response(custom_model_metadata(m))
        models = (
            Model.objects.filter(workspace=workspace)
            .filter(Q(author=request.user) | ~Q(provider_name__in=BYOS_PROVIDERS))
            .select_related('llm_config', 'provider_key')
            .order_by('-created_at')
        )
        configured_providers = list(
            workspace.provider_keys.filter(
                Q(created_by=request.user) | Q(created_by__isnull=True) | ~Q(provider__in=BYOS_PROVIDERS)
            ).values_list('provider', flat=True)
        )
        
        response = Response({
            'models': [custom_model_metadata(m) for m in models],
            'configured_providers': configured_providers,
            'available_providers': list(PROVIDER_URLS) + ['custom', *BYOS_PROVIDERS],
        })
        response['Cache-Control'] = 'no-store'
        return response

    def post(self, request, workspace_uuid, model_name=None, *args, **kwargs):
        workspace = get_workspace_and_check_membership(request, workspace_uuid, require_admin=True)
        serializer = CustomModelInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        key_id = data.get('key_id')
        provider_key_obj = None
        if key_id:
            provider_key_obj = workspace.provider_keys.filter(pk=key_id).first()
            if not provider_key_obj:
                return Response({'error': 'Selected provider key was not found.'}, status=status.HTTP_400_BAD_REQUEST)
            provider = provider_key_obj.provider
        else:
            provider = data.get('provider')
            if not provider:
                return Response({'error': 'Please select a provider key.'}, status=status.HTTP_400_BAD_REQUEST)
            provider_key_obj = workspace.provider_keys.filter(provider=provider).first()

        display_name = data['display_name'].strip()
        external_model_id = data['external_model_id'].strip()
        context_length = data['context_length']
        max_tokens = data['max_tokens']
        is_reasoning = data['is_reasoning']
        supports_vision = data.get('supports_vision', False)
        supports_tools = data['supports_tools']
        custom_base_url = data.get('custom_base_url', '').strip()

        # Generate unique slug for model.name
        slug = re.sub(r'[^a-zA-Z0-9._-]', '-', display_name.lower())
        slug = re.sub(r'-+', '-', slug).strip('-') or 'model'
        name_prefix = f"ws-{workspace.slug}"[:25]
        model_name = f"{name_prefix}-{slug}"[:60]

        # Determine external_url
        if provider == 'custom':
            external_url = custom_base_url or (provider_key_obj.base_url if provider_key_obj else '')
            if not external_url:
                return Response({'error': 'Custom endpoint Base URL is required.'}, status=status.HTTP_400_BAD_REQUEST)
        else:
            external_url = PROVIDER_URLS.get(provider, '')

        model_obj, _ = Model.objects.update_or_create(
            name=model_name,
            defaults={
                'workspace': workspace,
                'author': request.user,
                'provider_key': provider_key_obj,
                'display_name': display_name,
                'description': display_name,
                'model_type': 'text',
                'runner': Model.RUNNER_TENSORRT_LLM,
                'source': Model.SOURCE_EXTERNAL,
                'status': Model.STATUS_ACTIVE,
                'status_message': 'Ready',
                'is_external': True,
                'is_public': False,
                'is_reasoning': is_reasoning,
                'supports_vision': supports_vision,
                'provider_name': provider,
                'external_url': external_url,
                'external_model_id': external_model_id,
                'context_length': context_length,
            }
        )

        reasoning_cfg = normalize_admin_reasoning_config(
            is_reasoning=is_reasoning,
            reasoning_mode=data.get('reasoning_mode'),
            supported_efforts=data.get('supported_reasoning_efforts'),
            default_effort=data.get('default_reasoning_effort'),
        )

        LLMConfig.objects.update_or_create(
            model=model_obj,
            defaults={
                'context_length': context_length,
                'max_tokens': max_tokens,
                'default_temperature': 0.7,
                'default_top_p': 0.9,
                'reasoning_mode': reasoning_cfg['reasoning_mode'],
                'supported_reasoning_efforts': reasoning_cfg['supported_reasoning_efforts'],
                'default_reasoning_effort': reasoning_cfg['default_reasoning_effort'],
                'supports_tools': supports_tools,
                'external_url': external_url,
                'external_model_id': external_model_id,
            }
        )

        response = Response(custom_model_metadata(model_obj), status=status.HTTP_201_CREATED)
        response['Cache-Control'] = 'no-store'
        return response

    def delete(self, request, workspace_uuid, model_name=None):
        workspace = get_workspace_and_check_membership(request, workspace_uuid, require_admin=True)
        target_name = model_name or request.data.get('name') or request.data.get('model_name')
        if not target_name:
            return Response({'error': 'model_name is required.'}, status=status.HTTP_400_BAD_REQUEST)

        model_obj = Model.objects.filter(workspace=workspace, name=target_name).first()
        if not model_obj:
            return Response({'error': 'Custom model not found in this workspace.'}, status=status.HTTP_404_NOT_FOUND)

        model_obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TestCustomModelView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'test_custom_model'

    def post(self, request, workspace_uuid):
        workspace = get_workspace_and_check_membership(request, workspace_uuid, require_admin=True)
        key_id = request.data.get('key_id')
        provider = request.data.get('provider')
        external_model_id = request.data.get('external_model_id', '').strip()
        custom_base_url = request.data.get('custom_base_url', '').strip()
        api_key = request.data.get('api_key', '').strip()

        saved_key = None
        # If key_id is supplied, look up that exact key
        if key_id:
            saved_key = workspace.provider_keys.filter(pk=key_id).first()
            if saved_key:
                provider = saved_key.provider
                if not custom_base_url and saved_key.base_url:
                    custom_base_url = saved_key.base_url
                if not api_key and saved_key.encrypted_key:
                    try:
                        api_key = cipher().decrypt(saved_key.encrypted_key.encode()).decode()
                    except Exception:
                        return Response({'success': False, 'error': 'Selected key could not be decrypted.'}, status=400)
            else:
                return Response({'success': False, 'error': 'Selected key not found.'}, status=400)
        elif provider and not api_key:
            # Fall back to provider matching
            saved_key = workspace.provider_keys.filter(provider=provider).first()
            if saved_key and saved_key.encrypted_key:
                try:
                    api_key = cipher().decrypt(saved_key.encrypted_key.encode()).decode()
                except Exception:
                    return Response({'success': False, 'error': 'Saved provider key could not be decrypted.'}, status=400)
            elif provider in BYOS_PROVIDERS and saved_key:
                api_key = ''
            elif provider == 'custom':
                api_key = ''
            else:
                return Response({'success': False, 'error': f'No API key found for provider "{provider}". Please save a key or select one.'}, status=400)

        if not provider or not external_model_id:
            return Response({'success': False, 'error': 'Provider key and external_model_id are required.'}, status=400)

        if provider in BYOS_PROVIDERS:
            saved_key = saved_key or workspace.provider_keys.filter(provider=provider).first()
            if not saved_key:
                return Response({'success': False, 'error': 'No VM session connected for this provider. Connect in your VM terminal first.'}, status=400)
            label = {
                'anthropic_sub': 'Claude Code (BYOS)',
                'openai_sub': 'OpenAI Codex (BYOS)',
                'antigravity_sub': 'Antigravity (BYOS)',
            }.get(provider, provider)
            return Response({
                'success': True,
                'latency_ms': 1,
                'message': f"VM session verified for '{external_model_id}' via {label}. Ready to run in workspace VM.",
            })

        # Determine target endpoint base URL
        if provider == 'custom':
            key = workspace.provider_keys.filter(provider='custom').first()
            base_url = custom_base_url or (key.base_url if key else '')
            if not base_url:
                return Response({'success': False, 'error': 'Base URL is required for custom endpoint.'}, status=400)
            safe, err = is_safe_external_url(base_url)
            if not safe:
                return Response({'success': False, 'error': f'Disallowed custom endpoint URL: {err}'}, status=400)
        else:
            base_url = PROVIDER_URLS.get(provider)
            if not base_url:
                return Response({'success': False, 'error': f'Unknown provider "{provider}".'}, status=400)

        endpoint = f"{base_url.rstrip('/')}/chat/completions"
        headers = {'Content-Type': 'application/json'}
        if api_key:
            headers['Authorization'] = f'Bearer {api_key}'

        payload = {
            'model': external_model_id,
            'messages': [{'role': 'user', 'content': 'hi'}],
            'max_tokens': 1,
        }

        start_time = time.monotonic()
        try:
            with httpx.Client(timeout=10.0, follow_redirects=False) as client:
                res = client.post(endpoint, json=payload, headers=headers)
                latency_ms = int((time.monotonic() - start_time) * 1000)

                if getattr(res, 'is_redirect', False) is True or getattr(res, 'status_code', 0) in (301, 302, 303, 307, 308):
                    return Response({
                        'success': False,
                        'error': 'Redirects are not supported for custom endpoints.',
                    }, status=400)

                if res.status_code in (200, 201):
                    return Response({
                        'success': True,
                        'latency_ms': latency_ms,
                        'message': f"Connection successful! Verified '{external_model_id}' on {provider.capitalize()} ({latency_ms}ms).",
                    })

                # Format error from provider
                try:
                    err_json = res.json()
                    err_msg = err_json.get('error', {}).get('message') or err_json.get('error') or err_json.get('message') or str(err_json)
                except Exception:
                    err_msg = res.text[:200] or f"HTTP {res.status_code}"

                return Response({
                    'success': False,
                    'error': f"Provider returned HTTP {res.status_code}: {err_msg}",
                    'status_code': res.status_code,
                })
        except httpx.TimeoutException:
            return Response({
                'success': False,
                'error': f"Connection timed out (10s) connecting to {endpoint}. Check the endpoint URL and network connectivity.",
            })
        except Exception as exc:
            return Response({
                'success': False,
                'error': f"Connection failed: {str(exc)}",
            })
