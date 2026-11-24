import os
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from model.models import LLMConfig, Model
from model.reasoning import normalize_admin_reasoning_config


class Command(BaseCommand):
    help = "Seed or update an external OpenRouter LLM model in the database."

    def add_arguments(self, parser):
        parser.add_argument(
            "--name",
            type=str,
            default="deepseek-v4.1-flash",
            help="Unique model slug/name (default: deepseek-v4.1-flash)",
        )
        parser.add_argument(
            "--external-model-id",
            type=str,
            default="deepseek/deepseek-v4.1-flash",
            help="OpenRouter model ID (default: deepseek/deepseek-v4.1-flash)",
        )
        parser.add_argument(
            "--description",
            type=str,
            default="DeepSeek: DeepSeek V4.1 Flash",
            help="Model display description",
        )
        parser.add_argument(
            "--context-length",
            type=int,
            default=1048576,
            help="Context window length in tokens (default: 1048576)",
        )
        parser.add_argument(
            "--max-tokens",
            type=int,
            default=8192,
            help="Default max completion tokens (default: 8192)",
        )
        parser.add_argument(
            "--is-reasoning",
            action="store_true",
            default=True,
            help="Whether the model supports reasoning/thinking (default: True)",
        )
        parser.add_argument(
            "--reasoning-mode",
            type=str,
            default="effort",
            help="Reasoning control mode (none, effort, toggle, fixed)",
        )
        parser.add_argument(
            "--reasoning-tiers",
            type=str,
            default="",
            help="Comma-separated supported reasoning tiers (e.g. none,low,high,max)",
        )
        parser.add_argument(
            "--default-reasoning-effort",
            type=str,
            default="medium",
            help="Default reasoning effort tier",
        )

    def handle(self, *args, **options):
        api_key = getattr(settings, "OPENROUTER_API_KEY", None) or os.getenv("OPENROUTER_API_KEY", "")
        base_url = getattr(settings, "OPENROUTER_BASE_URL", None) or os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

        if not api_key:
            self.stdout.write(self.style.WARNING("Warning: OPENROUTER_API_KEY is not set or empty in environment!"))

        name = options["name"]
        external_model_id = options["external_model_id"]
        description = options["description"]
        context_length = options["context_length"]
        max_tokens = options["max_tokens"]
        is_reasoning = options["is_reasoning"]

        User = get_user_model()
        author = User.objects.filter(is_superuser=True).first() or User.objects.filter(is_staff=True).first() or User.objects.first()
        if not author:
            author = User.objects.create_superuser(
                username="admin",
                email="admin@neuronrunner.com",
                password="adminpassword123!",
            )
            self.stdout.write(self.style.SUCCESS(f"Created default superuser '{author.username}'."))

        gpu_requirements = {
            "category": "General LLM",
            "provider_preset": "openrouter",
        }

        readme_text = (
            "DeepSeek V4.1 Flash is a sparse mixture-of-experts model from DeepSeek built on "
            "the company's Causal Encoder-Decoder (CED) architecture, optimized for high throughput, "
            "agentic reasoning, and fast inference."
        )

        model_defaults = {
            "description": description,
            "readme": readme_text,
            "model_type": "text",
            "runner": Model.RUNNER_TENSORRT_LLM,
            "source": Model.SOURCE_EXTERNAL,
            "status": Model.STATUS_ACTIVE,
            "status_message": "Ready",
            "author": author,
            "gpu_requirements": gpu_requirements,
            "is_reasoning": is_reasoning,
            "is_external": True,
            "external_url": base_url,
            "external_model_id": external_model_id,
            "external_api_key": api_key,
            "context_length": context_length,
            "storage_path": "",
            "is_public": True,
        }

        model_obj, model_created = Model.objects.update_or_create(
            name=name,
            defaults=model_defaults,
        )

        llm_config_defaults = {
            "context_length": context_length,
            "max_tokens": max_tokens,
            "default_temperature": 0.7,
            "default_top_p": 0.9,
            **normalize_admin_reasoning_config(
                is_reasoning=is_reasoning,
                reasoning_mode=options.get("reasoning_mode"),
                supported_efforts=[
                    t.strip() for t in (options.get("reasoning_tiers") or "").split(",") if t.strip()
                ] or None,
                default_effort=options.get("default_reasoning_effort"),
            ),
            "system_prompt": "",
            "chat_template": "",
            "supports_tools": True,
            "quantization": "",
            "external_url": base_url,
            "external_model_id": external_model_id,
            "external_api_key": api_key,
        }

        llm_config, config_created = LLMConfig.objects.update_or_create(
            model=model_obj,
            defaults=llm_config_defaults,
        )

        action_m = "Created" if model_created else "Updated"
        action_c = "Created" if config_created else "Updated"

        self.stdout.write(
            self.style.SUCCESS(
                f"{action_m} Model '{model_obj.name}' (external_model_id='{external_model_id}') "
                f"and {action_c} LLMConfig successfully!"
            )
        )
