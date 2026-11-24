import json
from django.db.models import F, Q
from django.shortcuts import get_object_or_404
from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from model.models import LLMConfig, Model
from model.reasoning import normalize_admin_reasoning_config
from sandbox.models import WorkspaceProviderKey, WorkspaceMembership
from sandbox.services.provider_keys import BYOS_PROVIDERS, PROVIDER_URLS, cipher


ALL_PROVIDERS = list(PROVIDER_URLS) + ['custom', *BYOS_PROVIDERS]

BYOS_MODEL_CATALOG: dict[str, list[dict]] = {}


def validate_byos_secret(provider: str, secret: str) -> str:
    """Validate and normalize a BYOS subscription token or credential JSON payload."""
    trimmed = (secret or '').strip()
    if len(trimmed) < 12:
        raise ValueError('Subscription credential must be at least 12 characters.')
    if trimmed.startswith('{'):
        try:
            parsed = json.loads(trimmed)
        except ValueError as exc:
            raise ValueError(f'Invalid JSON credentials format: {exc}') from None
        if not isinstance(parsed, dict) or not parsed:
            raise ValueError('Credentials JSON must be a non-empty object.')
        if provider == 'anthropic_sub' and not any(
            k in parsed for k in ('claudeAiOauth', 'accessToken', 'oauthAccount', 'refreshToken')
        ):
            raise ValueError('Claude credentials JSON must contain OAuth credential fields (e.g. claudeAiOauth).')
        if provider == 'openai_sub' and not any(
            k in parsed for k in ('tokens', 'access_token', 'OPENAI_API_KEY', 'auth_mode')
        ):
            raise ValueError('Codex auth.json must contain token fields (e.g. tokens or access_token).')
        if provider == 'antigravity_sub' and not any(
            k in parsed for k in ('b64', 'access_token', 'refresh_token', 'expiry_date', 'id_token')
        ):
            raise ValueError('Antigravity OAuth credentials JSON must contain token fields (e.g. access_token or refresh_token).')
        return json.dumps(parsed)
    if any(char.isspace() or ord(char) < 32 for char in trimmed):
        raise ValueError('Invalid token format (must not contain whitespace or control characters).')
    return trimmed


def _mask_last4(secret: str) -> str:
    if not secret:
        return ''
    cleaned = secret.strip()
    if cleaned.startswith('{'):
        return 'JSON'
    return cleaned[-4:]


def _get_running_vm_runtime(workspace):
    """Return an active Docker sandbox runtime for this workspace if available."""
    from sandbox.services.sandbox_service import SandboxBootstrapService
    from sandbox.services.sandbox_session import get_sandbox_manager

    try:
        project = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
        return get_sandbox_manager().get_or_create(project)
    except Exception:
        return None


def sync_byos_models_for_provider(workspace, provider_key, user, status_out=None, *, runtime=None):
    """Sync BYOS Model records from the VM CLI or built-in CLI roster (no backend HTTP calls)."""
    from sandbox.services.byos_models import fetch_live_byos_models_with_status

    active_runtime = runtime if runtime is not None else _get_running_vm_runtime(workspace)
    live_specs, warning = fetch_live_byos_models_with_status(
        provider_key.provider,
        '',
        runtime=active_runtime,
    )
    if isinstance(status_out, dict):
        status_out['live_sync'] = bool(live_specs)
        status_out['warning'] = warning
    specs = live_specs or []
    ws_prefix = str(workspace.pk).split('-')[0]
    created_or_updated = []
    active_names = []
    for spec in specs:
        model_name = f"ws-{ws_prefix}-{spec['slug_suffix']}"[:60]
        active_names.append(model_name)
        model_obj, _ = Model.objects.update_or_create(
            name=model_name,
            defaults={
                'workspace': workspace,
                'author': user or workspace.owner,
                'provider_key': provider_key,
                'display_name': spec['display_name'],
                'description': spec['display_name'],
                'model_type': 'text',
                'runner': Model.RUNNER_TENSORRT_LLM,
                'source': Model.SOURCE_EXTERNAL,
                'status': Model.STATUS_ACTIVE,
                'status_message': 'Ready',
                'is_external': True,
                'is_public': False,
                'is_reasoning': spec['is_reasoning'],
                'supports_vision': spec['supports_vision'],
                'provider_name': provider_key.provider,
                'external_url': '',
                'external_model_id': spec['external_model_id'],
                'context_length': spec['context_length'],
            },
        )
        supported_efforts = spec.get('supported_efforts')
        if supported_efforts is None:
            supported_efforts = ['low', 'medium', 'high'] if spec['is_reasoning'] else []
        default_effort = spec.get('default_effort')
        if not default_effort:
            default_effort = 'medium' if spec['is_reasoning'] else 'none'
        reasoning_cfg = normalize_admin_reasoning_config(
            is_reasoning=spec['is_reasoning'],
            reasoning_mode='effort' if spec['is_reasoning'] else 'none',
            supported_efforts=supported_efforts if spec['is_reasoning'] else [],
            default_effort=default_effort if spec['is_reasoning'] else 'none',
        )
        LLMConfig.objects.update_or_create(
            model=model_obj,
            defaults={
                'context_length': spec['context_length'],
                'max_tokens': spec['max_tokens'],
                'default_temperature': 0.7,
                'default_top_p': 0.9,
                'reasoning_mode': reasoning_cfg['reasoning_mode'],
                'supported_reasoning_efforts': reasoning_cfg['supported_reasoning_efforts'],
                'default_reasoning_effort': reasoning_cfg['default_reasoning_effort'],
                'supports_tools': spec['supports_tools'],
                'external_url': '',
                'external_model_id': spec['external_model_id'],
            },
        )
        created_or_updated.append(model_obj)
    if live_specs and active_names:
        Model.objects.filter(
            workspace=workspace,
            provider_key=provider_key,
            provider_name=provider_key.provider,
        ).exclude(name__in=active_names).delete()
    return created_or_updated


def save_workspace_provider_credential(workspace, provider: str, secret: str = '', *, base_url: str = '', user=None, runtime=None):
    """Encrypt and store a workspace API key, or record a VM-only BYOS session without storing tokens."""
    if provider in BYOS_PROVIDERS:
        defaults = {
            'encrypted_key': '',
            'last4': 'VM',
            'base_url': '',
            'created_by': user,
        }
    else:
        defaults = {
            'encrypted_key': cipher().encrypt(secret.encode()).decode() if secret else '',
            'last4': _mask_last4(secret),
            'base_url': base_url,
            'created_by': user,
        }
    key, _ = WorkspaceProviderKey.objects.update_or_create(
        workspace=workspace,
        provider=provider,
        defaults=defaults,
    )
    if provider in BYOS_PROVIDERS:
        sync_byos_models_for_provider(workspace, key, user, runtime=runtime)
    return key


class ProviderKeyInput(serializers.Serializer):
    provider = serializers.ChoiceField(choices=ALL_PROVIDERS)
    api_key = serializers.CharField(write_only=True, trim_whitespace=True, required=False, allow_blank=True, default='', max_length=16384)
    base_url = serializers.URLField(required=False, allow_blank=True, default='')

    def validate(self, attrs):
        provider = attrs.get('provider')
        api_key = attrs.get('api_key', '').strip()
        base_url = attrs.get('base_url', '').strip()

        if provider in BYOS_PROVIDERS:
            raise serializers.ValidationError({
                'provider': 'CLI subscriptions must be signed into directly inside your Cloud VM terminal so OAuth credentials stay on the VM.'
            })
        elif provider != 'custom':
            if not api_key or len(api_key) < 12:
                raise serializers.ValidationError({'api_key': 'API key must be at least 12 characters.'})
            if any(char.isspace() or ord(char) < 32 for char in api_key):
                raise serializers.ValidationError({'api_key': 'Invalid API key format.'})
        else:
            if not base_url:
                raise serializers.ValidationError({'base_url': 'Base URL is required for custom endpoint.'})
            if api_key and any(char.isspace() or ord(char) < 32 for char in api_key):
                raise serializers.ValidationError({'api_key': 'Invalid API key format.'})

        return attrs


def metadata(key):
    auth_type = 'subscription' if key.provider in BYOS_PROVIDERS else 'api_key'
    if key.provider in BYOS_PROVIDERS or key.last4 == 'VM':
        masked = '(VM session)'
    elif key.last4 == 'JSON':
        masked = '(connected JSON)'
    elif key.last4:
        masked = '••••' + key.last4
    else:
        masked = '(no key required)'
    return {
        'uuid': str(key.pk),
        'provider': key.provider,
        'auth_type': auth_type,
        'masked_key': masked,
        'base_url': key.base_url,
        'updated_at': key.updated_at.isoformat(),
    }


def _get_manageable_workspace(request, workspace_uuid):
    membership = get_object_or_404(WorkspaceMembership.objects.select_related('workspace'), workspace_id=workspace_uuid, user=request.user)
    if membership.role not in ('owner', 'admin'):
        from rest_framework.exceptions import PermissionDenied
        raise PermissionDenied('Only workspace admins can manage provider keys.')
    return membership.workspace


class WorkspaceProviderKeysView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def workspace(self, request, workspace_uuid):
        return _get_manageable_workspace(request, workspace_uuid)

    def get(self, request, workspace_uuid):
        workspace = self.workspace(request, workspace_uuid)
        visible_keys = workspace.provider_keys.filter(
            Q(created_by=request.user) | Q(created_by__isnull=True) | ~Q(provider__in=BYOS_PROVIDERS)
        )
        response = Response({'keys': [metadata(key) for key in visible_keys], 'providers': ALL_PROVIDERS})
        response['Cache-Control'] = 'no-store'
        return response

    def put(self, request, workspace_uuid):
        workspace = self.workspace(request, workspace_uuid)
        serializer = ProviderKeyInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        secret = serializer.validated_data.get('api_key', '').strip()
        base_url = serializer.validated_data.get('base_url', '').strip()
        provider = serializer.validated_data['provider']

        key = save_workspace_provider_credential(
            workspace,
            provider,
            secret,
            base_url=base_url,
            user=request.user,
        )
        response = Response(metadata(key))
        response['Cache-Control'] = 'no-store'
        return response

    def delete(self, request, workspace_uuid):
        workspace = self.workspace(request, workspace_uuid)
        provider = request.data.get('provider')
        if provider not in ALL_PROVIDERS:
            return Response({'error': 'Invalid provider.'}, status=400)
        workspace.provider_keys.filter(provider=provider).delete()
        if provider in BYOS_PROVIDERS:
            Model.objects.filter(workspace=workspace, provider_name=provider).delete()
        return Response(status=204)


class WorkspaceProviderKeySyncFromVMView(APIView):
    """Verify authenticated CLI subscription files exist inside the workspace container without storing tokens."""
    permission_classes = [permissions.IsAuthenticated]

    CANDIDATE_PATHS = {
        'anthropic_sub': ['/root/.claude/.credentials.json', '/home/user/.claude/.credentials.json'],
        'openai_sub': ['/root/.codex/auth.json', '/home/user/.codex/auth.json'],
        'antigravity_sub': [
            '/root/.gemini/antigravity-cli/antigravity-oauth-token',
            '/home/user/.gemini/antigravity-cli/antigravity-oauth-token',
            '/root/.gemini/oauth_creds.json',
            '/home/user/.gemini/oauth_creds.json',
        ],
    }

    def post(self, request, workspace_uuid):
        workspace = _get_manageable_workspace(request, workspace_uuid)
        provider = str(request.data.get('provider') or '').strip()
        if provider not in BYOS_PROVIDERS:
            return Response({'error': 'Invalid BYOS subscription provider.'}, status=400)

        from sandbox.services.sandbox_service import SandboxBootstrapService
        from sandbox.services.sandbox_session import get_sandbox_manager

        project = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
        try:
            runtime = get_sandbox_manager().get_or_create(project)
        except Exception as exc:
            return Response({'error': str(exc)}, status=400)

        paths = self.CANDIDATE_PATHS[provider]
        check_script = (
            "import json, sys\n"
            "from pathlib import Path\n"
            "for p in sys.argv[1:]:\n"
            "    path = Path(p)\n"
            "    if path.is_file() and path.stat().st_size > 0:\n"
            "        print(json.dumps({'present': True, 'path': p}))\n"
            "        sys.exit(0)\n"
            "print(json.dumps({'present': False}))\n"
        )
        try:
            proc = runtime.exec('python3', '-c', check_script, *paths, timeout=30)
            output = proc.stdout.read()
            if proc.wait(30) != 0:
                return Response({'error': 'Could not verify credentials inside the workspace container.'}, status=400)
            payload = json.loads(output)
        except Exception as exc:
            return Response({'error': f'Failed to inspect container session status: {exc}'}, status=400)

        if not payload.get('present'):
            if provider == 'anthropic_sub':
                msg = "No Claude credentials found in container. Complete 'claude login' in the workspace terminal first."
            elif provider == 'openai_sub':
                msg = "No Codex credentials found in container. Complete 'codex login' in the workspace terminal first."
            else:
                msg = "No Antigravity / Gemini credentials found in container. Complete the CLI login in the workspace terminal first."
            return Response({'error': msg}, status=400)

        key = save_workspace_provider_credential(
            workspace,
            provider,
            user=request.user,
            runtime=runtime,
        )
        response = Response(metadata(key))
        response['Cache-Control'] = 'no-store'
        return response


class WorkspaceProviderVMLoginPrepareView(APIView):
    """Ensure the workspace sandbox exists and return the official CLI login command for the terminal."""
    permission_classes = [permissions.IsAuthenticated]

    LOGIN_COMMANDS = {
        'anthropic_sub': (
            'export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin:/root/.npm-global/bin:$PATH"; '
            'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY; '
            'rm -f ~/.claude/.credentials.json /root/.claude/.credentials.json /home/user/.claude/.credentials.json; '
            '(command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code@latest) && '
            '(claude auth login || claude login)'
        ),
        'openai_sub': (
            'export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin:/root/.npm-global/bin:$PATH"; '
            'unset OPENAI_API_KEY; '
            'rm -f ~/.codex/auth.json /root/.codex/auth.json /home/user/.codex/auth.json; '
            '(command -v codex >/dev/null 2>&1 || npm install -g @openai/codex@latest) && '
            'codex login --device-auth'
        ),
        'antigravity_sub': (
            'export PATH="/root/.gemini/bin:$HOME/.gemini/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/root/.npm-global/bin:$PATH"; '
            'unset GOOGLE_API_KEY GEMINI_API_KEY AGY_ADC_AUTH; '
            'rm -f ~/.gemini/antigravity-cli/antigravity-oauth-token /root/.gemini/antigravity-cli/antigravity-oauth-token /home/user/.gemini/antigravity-cli/antigravity-oauth-token '
            '~/.gemini/oauth_creds.json /root/.gemini/oauth_creds.json /home/user/.gemini/oauth_creds.json; '
            '(command -v agy >/dev/null 2>&1 || curl -fsSL https://antigravity.google/cli/install.sh | bash) && '
            'agy -p "Say OK" --output-format text'
        ),
    }

    def post(self, request, workspace_uuid):
        from sandbox.services.sandbox_service import SandboxBootstrapService
        from sandbox.services.sandbox_session import get_sandbox_manager

        workspace = _get_manageable_workspace(request, workspace_uuid)
        provider = str(request.data.get('provider') or '').strip()
        if provider not in BYOS_PROVIDERS:
            return Response({'error': 'Invalid BYOS subscription provider.'}, status=400)

        project = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
        try:
            get_sandbox_manager().get_or_create(project)
            ready = True
            status_detail = ''
        except Exception as exc:
            ready = False
            status_detail = str(exc)

        return Response({
            'provider': provider,
            'sandbox_uuid': str(project.uuid),
            'status_detail': status_detail,
            'ready': ready,
            'login_command': self.LOGIN_COMMANDS[provider],
            'auth_paths': WorkspaceProviderKeySyncFromVMView.CANDIDATE_PATHS[provider],
        })


class WorkspaceProviderRefreshModelsView(APIView):
    """Refresh model list for a connected BYOS provider from the running VM CLI."""
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, workspace_uuid):
        workspace = _get_manageable_workspace(request, workspace_uuid)
        provider = str(request.data.get('provider') or '').strip()
        if provider not in BYOS_PROVIDERS:
            return Response({'error': 'Invalid BYOS subscription provider.'}, status=400)
        key = WorkspaceProviderKey.objects.filter(workspace=workspace, provider=provider).first()
        if not key:
            return Response({'error': 'Provider is not connected.'}, status=404)
        sync_status = {}
        models = sync_byos_models_for_provider(workspace, key, request.user, status_out=sync_status)
        return Response({
            'provider': provider,
            'count': len(models),
            'live_sync': sync_status.get('live_sync', False),
            'warning': sync_status.get('warning'),
            'models': [{'name': m.name, 'display_name': m.display_name} for m in models],
        })


class WorkspaceLLMSetupView(APIView):
    """Onboarding (hello page) status, and the workspace's auxiliary model setting."""
    permission_classes = [permissions.IsAuthenticated]

    @staticmethod
    def _usable_models(workspace, user):
        from sandbox.services.provider_keys import filter_usable_models

        visible = Model.objects.filter(status=Model.STATUS_ACTIVE, model_type='text').filter(
            Q(is_public=True)
            | (Q(workspace=workspace) & (Q(author=user) | ~Q(provider_name__in=BYOS_PROVIDERS)))
        )
        return filter_usable_models(visible.distinct(), workspace)

    def _payload(self, membership, user):
        from sandbox.services.provider_keys import workspace_model_credentials

        workspace = membership.workspace
        usable = self._usable_models(workspace, user)
        auxiliary = workspace.auxiliary_model
        return {
            'can_manage': membership.role in ('owner', 'admin'),
            'configured_providers': sorted(set(workspace.provider_keys.values_list('provider', flat=True))),
            'usable_model_count': usable.count(),
            'usable_models': [
                {'name': m.name, 'display_name': m.display_name or m.name}
                # Workspace-specific models (picked on /hello) first.
                for m in usable.order_by(F('workspace_id').desc(nulls_last=True), 'display_name')[:100]
            ],
            'auxiliary_model': {
                'name': auxiliary.name,
                'display_name': auxiliary.display_name or auxiliary.name,
                'usable': workspace_model_credentials(auxiliary, workspace) is not None,
            } if auxiliary else None,
        }

    def _membership(self, request, workspace_uuid):
        return get_object_or_404(
            WorkspaceMembership.objects.select_related('workspace', 'workspace__auxiliary_model'),
            workspace_id=workspace_uuid,
            user=request.user,
        )

    def get(self, request, workspace_uuid):
        membership = self._membership(request, workspace_uuid)
        response = Response(self._payload(membership, request.user))
        response['Cache-Control'] = 'no-store'
        return response

    def put(self, request, workspace_uuid):
        """Set (``{"auxiliary_model": "<name>"}``) or clear (``null``) the auxiliary model."""
        from rest_framework.exceptions import PermissionDenied
        from sandbox.services.provider_keys import workspace_model_credentials

        membership = self._membership(request, workspace_uuid)
        if membership.role not in ('owner', 'admin'):
            raise PermissionDenied('Only workspace admins can change the auxiliary model.')
        workspace = membership.workspace
        name = request.data.get('auxiliary_model')
        if name in (None, ''):
            workspace.auxiliary_model = None
        else:
            model = self._usable_models(workspace, request.user).filter(name=str(name)).first()
            if model is None or workspace_model_credentials(model, workspace) is None:
                return Response(
                    {'error': 'Pick a model that runs on one of this workspace\'s API keys.'},
                    status=400,
                )
            workspace.auxiliary_model = model
        workspace.save(update_fields=['auxiliary_model', 'updated_at'])
        response = Response(self._payload(membership, request.user))
        response['Cache-Control'] = 'no-store'
        return response


def _token_prices(pricing) -> tuple[float | None, float | None]:
    """OpenRouter-style per-token prices as USD per million tokens."""
    if not isinstance(pricing, dict):
        return None, None

    def per_million(value):
        try:
            price = float(value)
        except (TypeError, ValueError):
            return None
        return round(price * 1_000_000, 6) if price >= 0 else None

    return per_million(pricing.get('prompt')), per_million(pricing.get('completion'))


class WorkspaceProviderRemoteModelsView(APIView):
    """List the models a saved API key can use, straight from the provider's /models endpoint."""
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = 'test_custom_model'
    MAX_MODELS = 1000

    def post(self, request, workspace_uuid):
        import httpx
        from utils.ssrf import is_safe_external_url

        workspace = _get_manageable_workspace(request, workspace_uuid)
        provider = str(request.data.get('provider') or '').strip()
        if provider not in PROVIDER_URLS and provider != 'custom':
            return Response({'error': 'Model listing is only available for API key providers.'}, status=400)
        key = WorkspaceProviderKey.objects.filter(workspace=workspace, provider=provider).first()
        if not key:
            return Response({'error': 'Save a key for this provider first.'}, status=404)

        secret = ''
        if key.encrypted_key:
            try:
                secret = cipher().decrypt(key.encrypted_key.encode()).decode()
            except Exception:
                return Response({'error': 'Saved provider key could not be decrypted.'}, status=400)

        if provider == 'custom':
            base_url = key.base_url
            safe, err = is_safe_external_url(base_url or '')
            if not base_url or not safe:
                return Response({'error': f'Invalid custom endpoint URL: {err or "missing"}'}, status=400)
        else:
            base_url = PROVIDER_URLS[provider]

        headers = {'Accept': 'application/json'}
        if secret:
            headers['Authorization'] = f'Bearer {secret}'
        try:
            with httpx.Client(timeout=15.0, follow_redirects=False) as client:
                if provider == 'openrouter':
                    # OpenRouter's model list is public, so check the key itself first.
                    key_check = client.get(f"{base_url.rstrip('/')}/key", headers=headers)
                    if key_check.status_code in (401, 403):
                        return Response({'error': 'The provider rejected this key. Check that it is correct and active.'}, status=400)
                res = client.get(f"{base_url.rstrip('/')}/models", headers=headers)
        except httpx.TimeoutException:
            return Response({'error': 'The provider did not answer in time. Try again.'}, status=502)
        except Exception as exc:
            return Response({'error': f'Could not reach the provider: {exc}'}, status=502)

        if res.status_code in (401, 403):
            return Response({'error': 'The provider rejected this key. Check that it is correct and active.'}, status=400)
        if res.status_code != 200:
            return Response({'error': f'Provider returned HTTP {res.status_code}.'}, status=502)
        try:
            payload = res.json()
        except ValueError:
            return Response({'error': 'Provider returned an invalid model list.'}, status=502)

        raw = payload.get('data') if isinstance(payload, dict) else payload
        models = []
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str):
                continue
            model_id = item['id']
            # Gemini's OpenAI-compatible endpoint prefixes ids with "models/".
            if provider == 'google' and model_id.startswith('models/'):
                model_id = model_id[len('models/'):]
            architecture = item.get('architecture') if isinstance(item.get('architecture'), dict) else {}
            input_modalities = architecture.get('input_modalities') or []
            output_modalities = architecture.get('output_modalities') or ['text']
            if 'text' not in output_modalities:
                continue
            supported = item.get('supported_parameters') or []
            context_length = item.get('context_length') or item.get('context_window')
            prompt_price, completion_price = _token_prices(item.get('pricing'))
            models.append({
                'id': model_id,
                'name': item.get('name') or model_id,
                'context_length': context_length if isinstance(context_length, int) else None,
                'supports_vision': 'image' in input_modalities,
                'supports_tools': ('tools' in supported) if supported else None,
                'is_reasoning': ('reasoning' in supported) if supported else None,
                # USD per million tokens when the provider says (OpenRouter does).
                'prompt_price': prompt_price,
                'completion_price': completion_price,
                'is_free': model_id.endswith(':free') or (prompt_price == 0 and completion_price == 0),
            })
            if len(models) >= self.MAX_MODELS:
                break
        models.sort(key=lambda m: m['name'].lower())
        response = Response({'provider': provider, 'models': models})
        response['Cache-Control'] = 'no-store'
        return response
