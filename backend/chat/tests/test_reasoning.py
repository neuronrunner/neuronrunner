from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from chat.models import Conversation, Request
from model.models import LLMConfig, Model

User = get_user_model()


class ChatReasoningIntegrationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="chat_reason_user",
            password="pass",
            email="chat_reason@example.com",
        )
        self.client.force_authenticate(user=self.user)
        from sandbox.services.workspace_auth import personal_workspace
        from sandbox.tests.byok_helpers import add_workspace_key
        add_workspace_key(personal_workspace(self.user))

        self.openrouter_effort_model = Model.objects.create(
            name="glm-tier-test",
            display_name="GLM Tier Test",
            model_type="text",
            author=self.user,
            is_external=True,
            is_public=True,
            external_url="https://openrouter.ai/api/v1",
            external_model_id="z-ai/glm-5.3",
            external_api_key="sk-or-test",
            is_reasoning=True,
            input_price=Decimal("0"),
            output_price=Decimal("0"),
        )
        LLMConfig.objects.create(
            model=self.openrouter_effort_model,
            reasoning_mode="effort",
            supported_reasoning_efforts=["low", "high", "max"],
            default_reasoning_effort="high",
        )

        self.openrouter_toggle_model = Model.objects.create(
            name="mimo-toggle-test",
            display_name="MiMo Toggle Test",
            model_type="text",
            author=self.user,
            is_external=True,
            is_public=True,
            external_url="https://openrouter.ai/api/v1",
            external_model_id="xiaomi/mimo-v2.6-flash",
            external_api_key="sk-or-test",
            is_reasoning=True,
            input_price=Decimal("0"),
            output_price=Decimal("0"),
        )
        LLMConfig.objects.create(
            model=self.openrouter_toggle_model,
            reasoning_mode="toggle",
            supported_reasoning_efforts=["none", "on"],
            default_reasoning_effort="on",
        )

        self.openrouter_fixed_model = Model.objects.create(
            name="kimi-fixed-test",
            display_name="Kimi Fixed Test",
            model_type="text",
            author=self.user,
            is_external=True,
            is_public=True,
            external_url="https://openrouter.ai/api/v1",
            external_model_id="moonshotai/kimi-k2.7-code",
            external_api_key="sk-or-test",
            is_reasoning=True,
            input_price=Decimal("0"),
            output_price=Decimal("0"),
        )
        LLMConfig.objects.create(
            model=self.openrouter_fixed_model,
            reasoning_mode="fixed",
            supported_reasoning_efforts=["on"],
            default_reasoning_effort="on",
        )

    def _mock_openai_response(self):
        mock_choice = MagicMock()
        mock_choice.message.content = "Done"
        mock_choice.message.reasoning_content = None
        mock_choice.message.tool_calls = None
        mock_resp = MagicMock()
        mock_resp.choices = [mock_choice]
        mock_resp.usage = MagicMock(
            prompt_tokens=10,
            completion_tokens=5,
            prompt_tokens_details=None,
        )
        return mock_resp

    @patch("chat.services.chat_service.OpenAI")
    @patch("chat.services.chat_service.ChatService._start_title_generation")
    @patch("chat.services.chat_service.ChatService._start_memory_job")
    def test_predict_sends_clamped_openrouter_reasoning_effort(
        self, _mock_mem, _mock_title, mock_openai_cls
    ):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = self._mock_openai_response()
        mock_openai_cls.return_value = mock_client

        res = self.client.post(
            f"/predict/{self.openrouter_effort_model.name}/",
            data={
                "content": "Hello",
                "stream": False,
                "reasoning_level": "medium",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200)

        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        self.assertEqual(call_kwargs.get("extra_body"), {"reasoning": {"effort": "high"}})
        self.assertNotIn("reasoning_effort", call_kwargs)

        req = Request.objects.get(model=self.openrouter_effort_model)
        self.assertEqual(req.reasoning_level, "high")

    @patch("chat.services.chat_service.OpenAI")
    @patch("chat.services.chat_service.ChatService._start_title_generation")
    @patch("chat.services.chat_service.ChatService._start_memory_job")
    def test_predict_toggle_model_sends_enabled_false_on_none(
        self, _mock_mem, _mock_title, mock_openai_cls
    ):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = self._mock_openai_response()
        mock_openai_cls.return_value = mock_client

        res = self.client.post(
            f"/predict/{self.openrouter_toggle_model.name}/",
            data={
                "content": "Quick answer",
                "stream": False,
                "reasoning_level": "none",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200)

        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        self.assertEqual(call_kwargs.get("extra_body"), {"reasoning": {"enabled": False}})
        self.assertNotIn("reasoning_effort", call_kwargs)

        req = Request.objects.get(model=self.openrouter_toggle_model)
        self.assertEqual(req.reasoning_level, "none")

    @patch("chat.services.chat_service.OpenAI")
    @patch("chat.services.chat_service.ChatService._start_title_generation")
    @patch("chat.services.chat_service.ChatService._start_memory_job")
    def test_predict_fixed_model_omits_reasoning_override_and_records_on(
        self, _mock_mem, _mock_title, mock_openai_cls
    ):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = self._mock_openai_response()
        mock_openai_cls.return_value = mock_client

        res = self.client.post(
            f"/predict/{self.openrouter_fixed_model.name}/",
            data={
                "content": "Think always",
                "stream": False,
                "reasoning_level": "none",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200)

        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        self.assertNotIn("extra_body", call_kwargs)
        self.assertNotIn("reasoning_effort", call_kwargs)

        req = Request.objects.get(model=self.openrouter_fixed_model)
        self.assertEqual(req.reasoning_level, "on")

    def test_recent_models_returns_per_model_reasoning_spec(self):
        conv = Conversation.objects.create(user=self.user, title="Recent")
        Request.objects.create(
            user=self.user,
            conversation=conv,
            model=self.openrouter_effort_model,
            reasoning_level="max",
            status="completed",
        )
        res = self.client.get("/recent-models/")
        self.assertEqual(res.status_code, 200)
        entry = next(r for r in res.data if r["name"] == self.openrouter_effort_model.name)
        self.assertEqual(entry["reasoning_mode"], "effort")
        self.assertEqual(entry["reasoning_tiers"], ["low", "high", "max"])
        self.assertEqual(entry["default_reasoning_effort"], "high")
