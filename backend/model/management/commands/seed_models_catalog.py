import os
from decimal import Decimal

from chat.models import Image, Request as ChatRequest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from model.models import LLMConfig, Model
from model.reasoning import (
    normalize_admin_reasoning_config,
    spec_from_openrouter_reasoning,
)
from model.services_pricing import OPENCODE_PRICE_FLOORS, retail_markup_multiplier, round_retail_price


MODELS_CATALOG = [
    # ─── Free Tier Models (is_free_tier = True) ───
    {
        'name': 'glm-5.3-flash',
        'display_name': 'GLM-5.3-Flash',
        'external_model_id': 'z-ai/glm-5.3-flash',
        'description': 'Z.ai GLM 5.3 Flash — fast, lightweight coding & agentic model with 1M context window.',
        'context_length': 1048576,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': True,
    },
    {
        'name': 'deepseek-v4.1-flash-1017',
        'display_name': 'DeepSeek V4.1 Flash',
        'external_model_id': 'deepseek/deepseek-v4.1-flash-1017',
        'description': 'DeepSeek V4.1 Flash — high-throughput MoE model optimized for coding and agentic tool use.',
        'context_length': 1048576,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': True,
    },
    {
        'name': 'mimo-v2.6-flash',
        'display_name': 'MiMo-V2.6-Flash',
        'external_model_id': 'xiaomi/mimo-v2.6-flash',
        'description': 'Xiaomi MiMo V2.6 Flash — high-efficiency reasoning and software engineering model.',
        'context_length': 262144,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': True,
    },
    {
        'name': 'qwen3.8-flash',
        'display_name': 'Qwen3.8 Flash',
        'external_model_id': 'qwen/qwen3.8-flash',
        'description': 'Qwen 3.8 Flash — fast 1M context coding and reasoning model by Alibaba Cloud.',
        'context_length': 1000000,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': True,
    },
    {
        'name': 'gpt-6-luna',
        'display_name': 'GPT 6 Luna',
        'external_model_id': 'openai/gpt-6-luna',
        'description': 'OpenAI GPT-6 Luna — fast, compact next-gen model with 1M+ context and reliable tool calling.',
        'context_length': 1050000,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': True,
    },
    {
        'name': 'claude-haiku-5.5',
        'display_name': 'Claude Haiku 5.5',
        'external_model_id': 'anthropic/claude-haiku-5.5',
        'description': 'Anthropic Claude Haiku 5.5 — rapid coding, terminal execution, and agentic workflows.',
        'context_length': 1000000,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': True,
    },
    # ─── Premium Models (is_free_tier = False) ───
    {
        'name': 'deepseek-v4-pro',
        'display_name': 'DeepSeek V4 Pro',
        'external_model_id': 'deepseek/deepseek-v4-pro-0813',
        'description': 'DeepSeek V4 Pro — deep reasoning and complex systems engineering model.',
        'context_length': 1048576,
        'is_reasoning': True,
        'is_free_tier': False,
    },
    {
        'name': 'glm-5.3',
        'display_name': 'GLM-5.3',
        'external_model_id': 'z-ai/glm-5.3',
        'description': 'Z.ai GLM 5.3 — flagship 1M context reasoning and agentic coding model.',
        'context_length': 1048576,
        'is_reasoning': True,
        'is_free_tier': False,
    },
    {
        'name': 'grok-4.7',
        'display_name': 'Grok 4.7',
        'external_model_id': 'x-ai/grok-4.7',
        'description': 'xAI Grok 4.7 — frontier reasoning, coding, and technical problem-solving model.',
        'context_length': 500000,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': False,
    },
    {
        'name': 'qwen3.8-max',
        'display_name': 'Qwen3.8 Max',
        'external_model_id': 'qwen/qwen3.8-max-0902',
        'description': 'Qwen 3.8 Max — Alibaba Cloud flagship model for complex coding and reasoning.',
        'context_length': 1000000,
        'is_reasoning': True,
        'is_free_tier': False,
    },
    {
        'name': 'kimi-k3.1-pro',
        'display_name': 'Kimi K3.1 Pro',
        'external_model_id': 'moonshotai/kimi-k3.1-pro',
        'description': 'MoonshotAI Kimi K3.1 Pro — flagship 1M context reasoning and autonomous coding model.',
        'context_length': 1048576,
        'is_reasoning': True,
        'is_free_tier': False,
    },
    {
        'name': 'gemini-4-hydrogen',
        'display_name': 'Gemini 4 Hydrogen',
        'external_model_id': 'google/gemini-4-hydrogen',
        'description': 'Google Gemini 4 Hydrogen — next-generation multimodal engineering and coding model with 1M context.',
        'context_length': 1048576,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': False,
    },
    {
        'name': 'gpt-6.1-sol',
        'display_name': 'GPT-6.1 Sol',
        'external_model_id': 'openai/gpt-6.1-sol',
        'description': 'OpenAI GPT-6.1 Sol — high-capability agentic coding, computer use, and reasoning model with 1M+ context.',
        'context_length': 1050000,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': False,
    },
    {
        'name': 'gpt-6.1-terra',
        'display_name': 'GPT-6.1 Terra',
        'external_model_id': 'openai/gpt-6.1-terra',
        'description': 'OpenAI GPT-6.1 Terra — cost-efficient reasoning and software engineering model with 1M+ context.',
        'context_length': 1050000,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': False,
    },
    {
        'name': 'claude-sonnet-5.5',
        'display_name': 'Claude Sonnet 5.5',
        'external_model_id': 'anthropic/claude-sonnet-5.5',
        'description': 'Anthropic Claude Sonnet 5.5 — high-precision software engineering, code review, and agentic tool use.',
        'context_length': 1000000,
        'is_reasoning': True,
        'supports_vision': True,
        'is_free_tier': False,
    },
]

# Verified per-model reasoning capabilities (synced with OpenRouter & models.dev).
# Used as the deterministic baseline when seeding offline or when OpenRouter omits fields.
MODEL_REASONING_SPECS = {
    'z-ai/glm-5.3-flash': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['low', 'high', 'max'], 'default_reasoning_effort': 'max'},
    'deepseek/deepseek-v4.1-flash-1017': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['none', 'low', 'high', 'max'], 'default_reasoning_effort': 'high'},
    'xiaomi/mimo-v2.6-flash': {'reasoning_mode': 'toggle', 'supported_reasoning_efforts': ['none', 'on'], 'default_reasoning_effort': 'on'},
    'qwen/qwen3.8-flash': {'reasoning_mode': 'toggle', 'supported_reasoning_efforts': ['none', 'on'], 'default_reasoning_effort': 'on'},
    'openai/gpt-6-luna': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'default_reasoning_effort': 'medium'},
    'anthropic/claude-haiku-5.5': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'default_reasoning_effort': 'medium'},
    'deepseek/deepseek-v4-pro-0813': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['none', 'low', 'high', 'max'], 'default_reasoning_effort': 'high'},
    'z-ai/glm-5.3': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['low', 'high', 'max'], 'default_reasoning_effort': 'max'},
    'x-ai/grok-4.7': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['low', 'medium', 'high', 'xhigh'], 'default_reasoning_effort': 'high'},
    'qwen/qwen3.8-max-0902': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['minimal', 'low', 'medium', 'high', 'xhigh'], 'default_reasoning_effort': 'xhigh'},
    'moonshotai/kimi-k3.1-pro': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['none', 'low', 'high', 'max'], 'default_reasoning_effort': 'max'},
    'google/gemini-4-hydrogen': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['low', 'medium', 'high', 'xhigh'], 'default_reasoning_effort': 'medium'},
    'openai/gpt-6.1-sol': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['low', 'medium', 'high', 'xhigh', 'max'], 'default_reasoning_effort': 'medium'},
    'openai/gpt-6.1-terra': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'default_reasoning_effort': 'medium'},
    'anthropic/claude-sonnet-5.5': {'reasoning_mode': 'effort', 'supported_reasoning_efforts': ['low', 'medium', 'high', 'xhigh', 'max'], 'default_reasoning_effort': 'high'},
}


class Command(BaseCommand):
    help = 'Seed the full OpenCode-equalized LLM model catalog (Free Tier and Premium models).'

    def handle(self, *args, **options):
        api_key = getattr(settings, 'OPENROUTER_API_KEY', None) or os.getenv('OPENROUTER_API_KEY', '')
        base_url = getattr(settings, 'OPENROUTER_BASE_URL', None) or os.getenv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1')

        User = get_user_model()
        author = (
            User.objects.filter(is_superuser=True).first()
            or User.objects.filter(is_staff=True).first()
            or User.objects.first()
        )
        if not author:
            author = User.objects.create_superuser(
                username='admin',
                email='admin@neuronrunner.com',
                password='adminpassword123!',
            )

        legacy_names = [
            'deepseek-v4.1-flash',
            'claude-opus-5.5',
            'minimax-m3.1-flash',
            'tencent-hy3',
            'gpt-5.6-luna',
            'longcat-2.0',
            'minimax-m3',
            'qwen3.7-plus',
            'mimo-v2.6-pro',
            'tencent-hy4',
            'kimi-k2.7-code',
            'step-5-preview',
            'glm-5.2',
            'kimi-k3',
            'gemini-3.8-flash',
            'gemini-4-carbon',
        ]
        legacy_deepseek = Model.objects.filter(name='deepseek-v4.1-flash').first()

        or_models = {}
        try:
            import requests
            res = requests.get('https://openrouter.ai/api/v1/models', timeout=15)
            if res.ok:
                for m in res.json().get('data', []):
                    or_models[m.get('id')] = m
                self.stdout.write(self.style.SUCCESS(f"Fetched {len(or_models)} models from OpenRouter for capability verification."))
        except Exception as exc:
            self.stdout.write(self.style.WARNING(f"Could not reach OpenRouter API: {exc}"))

        def _wholesale_from_or(pricing_dict):
            res_prices = {}
            if not isinstance(pricing_dict, dict):
                return res_prices
            for target, source_key in (
                ('wholesale_input_price', 'prompt'),
                ('wholesale_output_price', 'completion'),
                ('wholesale_cache_read_price', 'input_cache_read'),
            ):
                raw = pricing_dict.get(source_key)
                if raw is None:
                    continue
                try:
                    val = Decimal(str(raw)) * Decimal(1_000_000)
                    if val.is_finite() and val >= 0:
                        res_prices[target] = val
                except Exception:
                    continue
            return res_prices

        created_by_name = {}
        with transaction.atomic():
            for item in MODELS_CATALOG:
                ext_id = item['external_model_id']
                inp, out, cache_read = OPENCODE_PRICE_FLOORS[ext_id]

                or_model = or_models.get(ext_id)
                fallback_reasoning = MODEL_REASONING_SPECS.get(ext_id) or normalize_admin_reasoning_config(
                    is_reasoning=item['is_reasoning'],
                    reasoning_mode=item.get('reasoning_mode'),
                    supported_efforts=item.get('supported_reasoning_efforts'),
                    default_effort=item.get('default_reasoning_effort'),
                )
                if or_model:
                    arch = or_model.get('architecture', {})
                    input_mods = arch.get('input_modalities', [])
                    modality = arch.get('modality', '')
                    supports_vision = 'image' in input_mods or 'image->' in modality
                    live_reasoning = spec_from_openrouter_reasoning(
                        or_model.get('reasoning'),
                        or_model.get('supported_parameters'),
                    )
                    reasoning_cfg = live_reasoning or fallback_reasoning
                    wholesale_prices = _wholesale_from_or(or_model.get('pricing'))
                    markup = retail_markup_multiplier()
                    if wholesale_prices.get('wholesale_input_price') is not None:
                        inp = max(inp, round_retail_price(wholesale_prices['wholesale_input_price'] * markup))
                    if wholesale_prices.get('wholesale_output_price') is not None:
                        out = max(out, round_retail_price(wholesale_prices['wholesale_output_price'] * markup))
                    if cache_read is not None and wholesale_prices.get('wholesale_cache_read_price') is not None:
                        cache_read = max(cache_read, round_retail_price(wholesale_prices['wholesale_cache_read_price'] * markup))
                else:
                    supports_vision = item.get('supports_vision', False)
                    reasoning_cfg = fallback_reasoning
                    wholesale_prices = {}

                model_defaults = {
                    'display_name': item['display_name'],
                    'description': item['description'],
                    'readme': item['description'],
                    'model_type': 'text',
                    'runner': Model.RUNNER_TENSORRT_LLM,
                    'source': Model.SOURCE_EXTERNAL,
                    'status': Model.STATUS_ACTIVE,
                    'status_message': 'Ready',
                    'author': author,
                    'gpu_requirements': {
                        'category': 'Free Tier LLM' if item['is_free_tier'] else 'General LLM',
                        'provider_preset': 'openrouter',
                    },
                    'is_reasoning': reasoning_cfg['reasoning_mode'] != LLMConfig.REASONING_MODE_NONE,
                    'supports_vision': supports_vision,
                    'is_free_tier': item['is_free_tier'],
                    'is_external': True,
                    'provider_name': 'openrouter',
                    'external_url': base_url,
                    'external_model_id': ext_id,
                    'external_api_key': api_key,
                    'input_price': inp,
                    'output_price': out,
                    'cache_read_price': cache_read,
                    'context_length': item['context_length'],
                    'storage_path': ext_id,
                    'is_public': True,
                    **wholesale_prices,
                }

                model_obj, created = Model.objects.update_or_create(
                    name=item['name'],
                    defaults=model_defaults,
                )
                created_by_name[item['name']] = model_obj

                LLMConfig.objects.update_or_create(
                    model=model_obj,
                    defaults={
                        'context_length': item['context_length'],
                        'max_tokens': 8192,
                        'default_temperature': 0.7,
                        'default_top_p': 0.9,
                        'reasoning_mode': reasoning_cfg['reasoning_mode'],
                        'supported_reasoning_efforts': reasoning_cfg['supported_reasoning_efforts'],
                        'default_reasoning_effort': reasoning_cfg['default_reasoning_effort'],
                        'supports_tools': True,
                        'external_url': base_url,
                        'external_model_id': ext_id,
                        'external_api_key': api_key,
                    },
                )
                tier_tag = 'FREE' if item['is_free_tier'] else 'PAID'
                action = 'Created' if created else 'Updated'
                self.stdout.write(
                    self.style.SUCCESS(
                        f"[{tier_tag}] {action} {model_obj.display_name} ({ext_id}) -> in=${inp} out=${out} cache=${cache_read}"
                    )
                )

            replacement_deepseek = created_by_name.get('deepseek-v4.1-flash-1017')
            if legacy_deepseek and replacement_deepseek and legacy_deepseek.pk != replacement_deepseek.pk:
                reassigned_reqs = ChatRequest.objects.filter(model=legacy_deepseek).update(model=replacement_deepseek)
                reassigned_imgs = Image.objects.filter(model=legacy_deepseek).update(model=replacement_deepseek)
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Reassigned {reassigned_reqs} requests and {reassigned_imgs} images from deepseek-v4.1-flash to deepseek-v4.1-flash-1017."
                    )
                )

            Model.objects.filter(name__in=legacy_names).delete()
