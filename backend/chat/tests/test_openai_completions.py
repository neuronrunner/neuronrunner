import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from chat.models import Conversation, Message, Request
from model.models import Model

User = get_user_model()


class StatefulOpenAICompletionsTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username='test_user',
            password='testpass123',
            email='test@example.com',
        )
        self.client.force_authenticate(user=self.user)
        from sandbox.services.workspace_auth import personal_workspace
        _ws = personal_workspace(self.user)
        from sandbox.tests.byok_helpers import add_workspace_key
        add_workspace_key(_ws, 'openai', 'sk-openai-workspace-key')
        add_workspace_key(_ws, 'openrouter')
        self.author = User.objects.create_user(
            username='author',
            password='pass',
            email='author@example.com',
        )
        self.model = Model.objects.create(
            name='test-text-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='gpt-4',
            external_api_key='sk-test',
            external_url='https://api.openai.com/v1',
            input_price=Decimal('1.00'),
            output_price=Decimal('2.00'),
        )

    @patch('chat.services.chat_service.OpenAI')
    @patch('chat.services.chat_service.ChatService._start_title_generation')
    @patch('chat.services.chat_service.ChatService._start_memory_job')
    def test_stateful_chat_completions_extracts_parameters_successfully(
        self, mock_memory_job, mock_title_gen, mock_openai_cls
    ):
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(message=SimpleNamespace(content='Hello there!'))]
        mock_response.usage = SimpleNamespace(prompt_tokens=10, completion_tokens=20)
        mock_client.chat.completions.create.return_value = mock_response

        response = self.client.post(
            '/v1/chat/completions',
            data=json.dumps({
                'model': 'test-text-model',
                'stateful': True,
                'messages': [{'role': 'user', 'content': 'Hello from client!'}],
                'stream': False,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(Conversation.objects.filter(user=self.user).count(), 1)
        self.assertEqual(Message.objects.filter(role='user', content='Hello from client!').count(), 1)
        self.assertEqual(Request.objects.count(), 1)

    def test_extract_parameters_backward_compatibility(self):
        from chat.views.predict import _extract_parameters

        class DummyRequest:
            data = {'reasoning_level': 'high', 'temperature': 0.5, 'top_p': 0.8}

        # Test both old and new calling conventions
        params1 = _extract_parameters(
            DummyRequest(),
            is_image_model=False,
            user_content='test content',
            user_msg='msg',
            model_obj=self.model,
            regenerate_source=None,
            attachments_context='',
            img2img_file=None,
        )
        self.assertEqual(params1['temperature'], 0.5)
        self.assertEqual(params1['top_p'], 0.8)
        self.assertEqual(params1['user_msg'], 'msg')

        params2 = _extract_parameters(
            DummyRequest(),
            user_msg='msg2',
            model_obj=self.model,
            attachments_context='ctx',
        )
        self.assertEqual(params2['user_msg'], 'msg2')
        self.assertEqual(params2['attachments_context'], 'ctx')
