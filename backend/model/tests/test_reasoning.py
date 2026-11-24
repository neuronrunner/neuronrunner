from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from model.management.commands.seed_models_catalog import MODELS_CATALOG
from model.models import LLMConfig, Model
from model.reasoning import (
    build_reasoning_request_kwargs,
    get_model_reasoning_spec,
    normalize_admin_reasoning_config,
    resolve_reasoning_level,
    spec_from_openrouter_reasoning,
)

User = get_user_model()


class ReasoningHelperTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="reason_user",
            password="pass",
            email="reason@example.com",
        )

    def _create_model(
        self,
        name,
        *,
        is_reasoning=True,
        mode="effort",
        tiers=None,
        default="medium",
        external_url="https://openrouter.ai/api/v1",
    ):
        m = Model.objects.create(
            name=name,
            model_type="text",
            author=self.user,
            is_external=True,
            external_url=external_url,
            external_model_id=f"test/{name}",
            is_reasoning=is_reasoning,
        )
        LLMConfig.objects.create(
            model=m,
            reasoning_mode=mode,
            supported_reasoning_efforts=tiers or [],
            default_reasoning_effort=default,
        )
        return m

    def test_resolve_clamps_to_model_tiers(self):
        # Mandatory model without "none" or "medium"
        glm = self._create_model(
            "glm-mandatory",
            mode="effort",
            tiers=["low", "high", "max"],
            default="max",
        )
        self.assertEqual(resolve_reasoning_level(glm, None), "max")
        self.assertEqual(resolve_reasoning_level(glm, "none"), "low")
        self.assertEqual(resolve_reasoning_level(glm, "medium"), "high")
        self.assertEqual(resolve_reasoning_level(glm, "xhigh"), "max")
        self.assertEqual(resolve_reasoning_level(glm, "high"), "high")

        # Toggle model
        toggle_m = self._create_model(
            "qwen-toggle",
            mode="toggle",
            tiers=["none", "on"],
            default="on",
        )
        self.assertEqual(resolve_reasoning_level(toggle_m, "high"), "on")
        self.assertEqual(resolve_reasoning_level(toggle_m, "none"), "none")
        self.assertEqual(resolve_reasoning_level(toggle_m, "off"), "none")

        # Fixed always-on model
        fixed_m = self._create_model(
            "kimi-fixed",
            mode="fixed",
            tiers=["on"],
            default="on",
        )
        self.assertEqual(resolve_reasoning_level(fixed_m, "none"), "on")
        self.assertEqual(resolve_reasoning_level(fixed_m, "low"), "on")

    def test_build_reasoning_request_kwargs_openrouter_vs_openai(self):
        or_effort = self._create_model(
            "or-effort",
            mode="effort",
            tiers=["none", "low", "high", "max"],
            default="high",
            external_url="https://openrouter.ai/api/v1",
        )
        self.assertEqual(
            build_reasoning_request_kwargs(or_effort, "max", or_effort.external_url),
            {"extra_body": {"reasoning": {"effort": "max"}}},
        )
        self.assertEqual(
            build_reasoning_request_kwargs(or_effort, "none", or_effort.external_url),
            {"extra_body": {"reasoning": {"effort": "none"}}},
        )
        # Missing medium snaps cleanly to high for OpenRouter
        self.assertEqual(
            build_reasoning_request_kwargs(or_effort, "medium", or_effort.external_url),
            {"extra_body": {"reasoning": {"effort": "high"}}},
        )

        or_toggle = self._create_model(
            "or-toggle",
            mode="toggle",
            tiers=["none", "on"],
            default="on",
            external_url="https://openrouter.ai/api/v1",
        )
        self.assertEqual(
            build_reasoning_request_kwargs(or_toggle, "none", or_toggle.external_url),
            {"extra_body": {"reasoning": {"enabled": False}}},
        )
        self.assertEqual(
            build_reasoning_request_kwargs(or_toggle, "high", or_toggle.external_url),
            {"extra_body": {"reasoning": {"enabled": True}}},
        )

        or_fixed = self._create_model(
            "or-fixed",
            mode="fixed",
            tiers=["on"],
            default="on",
            external_url="https://openrouter.ai/api/v1",
        )
        self.assertEqual(
            build_reasoning_request_kwargs(or_fixed, "on", or_fixed.external_url),
            {},
        )

        direct_oai = self._create_model(
            "oai-effort",
            mode="effort",
            tiers=["low", "medium", "high"],
            default="medium",
            external_url="https://api.openai.com/v1",
        )
        self.assertEqual(
            build_reasoning_request_kwargs(direct_oai, "high", direct_oai.external_url),
            {"reasoning_effort": "high"},
        )

    def test_spec_from_openrouter_reasoning_shapes(self):
        self.assertEqual(
            spec_from_openrouter_reasoning(
                {
                    "mandatory": False,
                    "supported_efforts": ["low", "high", "max"],
                    "default_effort": "high",
                },
                ["reasoning", "reasoning_effort"],
            ),
            {
                "reasoning_mode": "effort",
                "supported_reasoning_efforts": ["none", "low", "high", "max"],
                "default_reasoning_effort": "high",
            },
        )
        self.assertEqual(
            spec_from_openrouter_reasoning(
                {
                    "mandatory": True,
                    "supported_efforts": ["low", "high", "max"],
                    "default_effort": None,
                },
                ["reasoning", "reasoning_effort"],
            ),
            {
                "reasoning_mode": "effort",
                "supported_reasoning_efforts": ["low", "high", "max"],
                "default_reasoning_effort": "high",
            },
        )
        self.assertEqual(
            spec_from_openrouter_reasoning({"mandatory": False, "default_enabled": True}, ["reasoning"]),
            {
                "reasoning_mode": "toggle",
                "supported_reasoning_efforts": ["none", "on"],
                "default_reasoning_effort": "on",
            },
        )
        self.assertEqual(
            spec_from_openrouter_reasoning({"mandatory": True, "default_enabled": True}, ["reasoning"]),
            {
                "reasoning_mode": "fixed",
                "supported_reasoning_efforts": ["on"],
                "default_reasoning_effort": "on",
            },
        )

    def test_normalize_admin_reasoning_config(self):
        self.assertEqual(
            normalize_admin_reasoning_config(True, "effort", ["max", "low", "invalid"], "medium"),
            {
                "reasoning_mode": "effort",
                "supported_reasoning_efforts": ["low", "max"],
                "default_reasoning_effort": "low",
            },
        )
        self.assertEqual(
            normalize_admin_reasoning_config(False, "effort", ["low"], "low"),
            {
                "reasoning_mode": "none",
                "supported_reasoning_efforts": [],
                "default_reasoning_effort": "none",
            },
        )


class CatalogSeedAndApiReasoningTests(TestCase):
    def setUp(self):
        self.staff = User.objects.create_user(
            username="staff_reason",
            password="pass",
            email="staff_reason@example.com",
            is_staff=True,
        )
        self.client = APIClient()

    @patch("requests.get", side_effect=OSError("offline test"))
    def test_seed_models_catalog_populates_per_model_reasoning_tiers(self, _mock_get):
        call_command("seed_models_catalog")

        self.assertEqual(Model.objects.filter(name__in=[m["name"] for m in MODELS_CATALOG]).count(), len(MODELS_CATALOG))

        expectations = {
            "deepseek-v4.1-flash-1017": ("effort", ["none", "low", "high", "max"], "high"),
            "glm-5.3-flash": ("effort", ["low", "high", "max"], "max"),
            "mimo-v2.6-flash": ("toggle", ["none", "on"], "on"),
            "qwen3.8-flash": ("toggle", ["none", "on"], "on"),
            "gpt-6-luna": ("effort", ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
            "qwen3.8-max": ("effort", ["minimal", "low", "medium", "high", "xhigh"], "xhigh"),
            "glm-5.3": ("effort", ["low", "high", "max"], "max"),
            "kimi-k3.1-pro": ("effort", ["none", "low", "high", "max"], "max"),
            "gemini-4-hydrogen": ("effort", ["low", "medium", "high", "xhigh"], "medium"),
            "claude-sonnet-5.5": ("effort", ["low", "medium", "high", "xhigh", "max"], "high"),
        }

        for slug, (exp_mode, exp_tiers, exp_default) in expectations.items():
            model = Model.objects.select_related("llm_config").get(name=slug)
            spec = get_model_reasoning_spec(model)
            self.assertEqual(spec["mode"], exp_mode, slug)
            self.assertEqual(spec["tiers"], exp_tiers, slug)
            self.assertEqual(spec["default"], exp_default, slug)

            res = self.client.get(f"/models/{slug}/")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.data["reasoning_mode"], exp_mode, slug)
            self.assertEqual(res.data["reasoning_tiers"], exp_tiers, slug)
            self.assertEqual(res.data["default_reasoning_effort"], exp_default, slug)
