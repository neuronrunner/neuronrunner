"""
Tests for the OpenAI-compatible API endpoint.
"""
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from chat.models import Conversation, Request
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from model.models import Model
from rest_framework.test import APIClient

User = get_user_model()


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class OpenAICompatValidationTests(TestCase):
    """Test input validation for the OpenAI-compatible endpoint."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123',
            email='test@example.com',
        )
        self.client.force_authenticate(user=self.user)
        from decimal import Decimal
        from sandbox.services.workspace_auth import personal_workspace
        _ws = personal_workspace(self.user)
        from sandbox.tests.byok_helpers import add_workspace_key
        add_workspace_key(_ws, 'openai', 'sk-openai-workspace-key')
        add_workspace_key(_ws, 'openrouter')
        self.url = '/v1/chat/completions'

        self.author = User.objects.create_user(
            username='author', password='pass', email='author@example.com'
        )
        self.text_model = Model.objects.create(
            name='test-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='gpt-4',
            external_api_key='sk-test',
            external_url='https://api.openai.com/v1',
        )

    def test_requires_authentication(self):
        unauthenticated_client = APIClient()
        response = unauthenticated_client.post(
            self.url,
            data=json.dumps({'model': 'test-model', 'messages': [{'role': 'user', 'content': 'hi'}]}),
            content_type='application/json',
        )
        self.assertIn(response.status_code, [401, 403])

    def test_missing_model_returns_400(self):
        response = self.client.post(
            self.url,
            data=json.dumps({'messages': [{'role': 'user', 'content': 'hi'}]}),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('error', response.data)
        self.assertIn('model', response.data['error']['message'].lower())

    def test_empty_messages_returns_400(self):
        response = self.client.post(
            self.url,
            data=json.dumps({'model': 'test-model', 'messages': []}),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('error', response.data)

    def test_messages_not_list_returns_400(self):
        response = self.client.post(
            self.url,
            data=json.dumps({'model': 'test-model', 'messages': 'not a list'}),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_last_message_not_user_returns_400(self):
        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'test-model',
                'messages': [
                    {'role': 'user', 'content': 'hi'},
                    {'role': 'assistant', 'content': 'hello'},
                ],
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('error', response.data)

    def test_empty_user_message_returns_400(self):
        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'test-model',
                'messages': [{'role': 'user', 'content': '   '}],
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_model_not_found_returns_404(self):
        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'nonexistent-model',
                'messages': [{'role': 'user', 'content': 'hi'}],
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 404)

    def test_image_model_returns_400(self):
        author, _ = User.objects.get_or_create(
            username='image-author', defaults={'password': 'pass', 'email': 'image-author@example.com'}
        )
        Model.objects.create(
            name='image-model',
            model_type='image',
            author=author,
        )

        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'image-model',
                'messages': [{'role': 'user', 'content': 'generate an image'}],
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('error', response.data)


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class OpenAICompatSyncTests(TestCase):
    """Test synchronous generation for the OpenAI-compatible endpoint."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123',
            email='test@example.com',
        )
        self.client.force_authenticate(user=self.user)
        from decimal import Decimal
        from sandbox.services.workspace_auth import personal_workspace
        _ws = personal_workspace(self.user)
        from sandbox.tests.byok_helpers import add_workspace_key
        add_workspace_key(_ws, 'openai', 'sk-openai-workspace-key')
        add_workspace_key(_ws, 'openrouter')
        self.url = '/v1/chat/completions'

        self.author = User.objects.create_user(
            username='author', password='pass', email='author@example.com'
        )
        self.text_model = Model.objects.create(
            name='test-text-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='gpt-4',
            external_api_key='sk-test',
            external_url='https://api.openai.com/v1',
            input_price=0,
            output_price=0,
        )

    @patch('chat.services.chat_service.OpenAI')
    def test_sync_response_format(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(
            message=SimpleNamespace(content='Hello from AI!')
        )]
        mock_response.usage = SimpleNamespace(prompt_tokens=10, completion_tokens=20)
        mock_client.chat.completions.create.return_value = mock_response

        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'test-text-model',
                'messages': [{'role': 'user', 'content': 'Hello'}],
                'stream': False,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['object'], 'chat.completion')
        self.assertEqual(response.data['model'], 'test-text-model')
        self.assertEqual(len(response.data['choices']), 1)
        self.assertEqual(response.data['choices'][0]['message']['role'], 'assistant')
        self.assertEqual(response.data['choices'][0]['message']['content'], 'Hello from AI!')
        self.assertEqual(response.data['choices'][0]['finish_reason'], 'stop')
        self.assertIn('usage', response.data)
        self.assertEqual(response.data['usage']['prompt_tokens'], 10)
        self.assertEqual(response.data['usage']['completion_tokens'], 20)

    @patch('chat.services.chat_service.OpenAI')
    def test_sync_passes_messages_correctly(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(
            message=SimpleNamespace(content='Response')
        )]
        mock_response.usage = SimpleNamespace(prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        messages = [
            {'role': 'system', 'content': 'You are helpful'},
            {'role': 'user', 'content': 'Hi'},
            {'role': 'assistant', 'content': 'Hello'},
            {'role': 'user', 'content': 'How are you?'},
        ]

        self.client.post(
            self.url,
            data=json.dumps({'model': 'test-text-model', 'messages': messages, 'stream': False}),
            content_type='application/json',
        )

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        self.assertEqual(call_kwargs['messages'], messages)

    @patch('chat.services.chat_service.OpenAI')
    def test_sync_passes_temperature_and_top_p(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(
            message=SimpleNamespace(content='Response')
        )]
        mock_response.usage = SimpleNamespace(prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        self.client.post(
            self.url,
            data=json.dumps({
                'model': 'test-text-model',
                'messages': [{'role': 'user', 'content': 'Hi'}],
                'temperature': 0.5,
                'top_p': 0.8,
                'stream': False,
            }),
            content_type='application/json',
        )

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        self.assertEqual(call_kwargs['temperature'], 0.5)
        self.assertEqual(call_kwargs['top_p'], 0.8)

    @patch('chat.services.chat_service.OpenAI')
    def test_sync_passes_reasoning_effort_for_reasoning_model(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(
            message=SimpleNamespace(content='Response')
        )]
        mock_response.usage = SimpleNamespace(prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        Model.objects.create(
            name='reasoning-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='o1',
            external_api_key='sk-test',
            external_url='https://api.openai.com/v1',
            is_reasoning=True,
            input_price=0,
            output_price=0,
        )

        self.client.post(
            self.url,
            data=json.dumps({
                'model': 'reasoning-model',
                'messages': [{'role': 'user', 'content': 'Hi'}],
                'reasoning_level': 'high',
                'stream': False,
            }),
            content_type='application/json',
        )

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        self.assertEqual(call_kwargs.get('reasoning_effort'), 'high')

    @patch('chat.services.chat_service.OpenAI')
    def test_sync_accepts_reasoning_effort_param_and_clamps_to_model_tiers(self, mock_openai_cls):
        from model.models import LLMConfig

        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(
            message=SimpleNamespace(content='Response')
        )]
        mock_response.usage = SimpleNamespace(prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        m = Model.objects.create(
            name='openrouter-tiered-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='deepseek/deepseek-v4.1-flash-1017',
            external_api_key='sk-test',
            external_url='https://openrouter.ai/api/v1',
            is_reasoning=True,
            input_price=0,
            output_price=0,
        )
        LLMConfig.objects.create(
            model=m,
            reasoning_mode='effort',
            supported_reasoning_efforts=['none', 'low', 'high', 'max'],
            default_reasoning_effort='high',
        )

        res = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'openrouter-tiered-model',
                'messages': [{'role': 'user', 'content': 'Hi'}],
                'reasoning_effort': 'medium',
                'stream': False,
            }),
            content_type='application/json',
        )
        self.assertEqual(res.status_code, 200)
        call_kwargs = mock_client.chat.completions.create.call_args[1]
        self.assertEqual(call_kwargs.get('extra_body'), {'reasoning': {'effort': 'high'}})
        self.assertNotIn('reasoning_effort', call_kwargs)

    @patch('chat.services.chat_service.OpenAI')
    def test_sync_creates_db_records(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(
            message=SimpleNamespace(content='Response')
        )]
        mock_response.usage = SimpleNamespace(prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        conv_count_before = Conversation.objects.count()
        req_count_before = Request.objects.count()

        self.client.post(
            self.url,
            data=json.dumps({
                'model': 'test-text-model',
                'messages': [{'role': 'user', 'content': 'Hi'}],
                'stream': False,
            }),
            content_type='application/json',
        )

        self.assertEqual(Conversation.objects.count(), conv_count_before + 1)
        self.assertEqual(Request.objects.count(), req_count_before + 1)

        req = Request.objects.latest('created_at')
        self.assertEqual(req.status, 'completed')
        self.assertEqual(req.model, self.text_model)


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class OpenAICompatStreamingTests(TestCase):
    """Test streaming generation for the OpenAI-compatible endpoint."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123',
            email='test@example.com',
        )
        self.client.force_authenticate(user=self.user)
        from decimal import Decimal
        from sandbox.services.workspace_auth import personal_workspace
        _ws = personal_workspace(self.user)
        from sandbox.tests.byok_helpers import add_workspace_key
        add_workspace_key(_ws, 'openai', 'sk-openai-workspace-key')
        add_workspace_key(_ws, 'openrouter')
        self.url = '/v1/chat/completions'

        self.author = User.objects.create_user(
            username='author', password='pass', email='author@example.com'
        )
        self.text_model = Model.objects.create(
            name='test-text-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='gpt-4',
            external_api_key='sk-test',
            external_url='https://api.openai.com/v1',
            input_price=0,
            output_price=0,
        )

    def test_streaming_returns_event_stream_content_type(self):
        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'test-text-model',
                'messages': [{'role': 'user', 'content': 'Hello'}],
                'stream': True,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.streaming)
        self.assertEqual(response['Content-Type'], 'text/event-stream')


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class OpenAICompatBuildParamsTests(TestCase):
    """Test the _build_params helper function."""

    def test_extracts_user_msg_for_web_search(self):
        from openai_compat.views import _build_params

        class FakeRequest:
            data = {
                'temperature': 0.7,
                'top_p': 0.9,
                'reasoning_level': 'medium',
                'web_search': True,
                'web_search_max_results': 3,
            }

        class FakeModel:
            is_reasoning = True

        messages = [
            {'role': 'system', 'content': 'You are helpful'},
            {'role': 'user', 'content': 'What is the weather?'},
        ]

        params = _build_params(FakeRequest(), FakeModel(), messages)

        self.assertIsNone(params['user_msg'])
        self.assertNotIn('web_search', params)

    def test_handles_multimodal_content_array(self):
        from openai_compat.views import _build_params

        class FakeRequest:
            data = {}

        class FakeModel:
            is_reasoning = False

        messages = [
            {
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': 'Describe this image'},
                    {'type': 'image_url', 'image_url': {'url': 'http://example.com/img.jpg'}},
                ],
            },
        ]

        params = _build_params(FakeRequest(), FakeModel(), messages)

        self.assertIsNone(params['user_msg'])

    def test_user_msg_none_when_no_user_message(self):
        from openai_compat.views import _build_params

        class FakeRequest:
            data = {}

        class FakeModel:
            is_reasoning = False

        messages = [
            {'role': 'system', 'content': 'You are helpful'},
            {'role': 'assistant', 'content': 'Hello'},
        ]

        params = _build_params(FakeRequest(), FakeModel(), messages)

        self.assertIsNone(params['user_msg'])

    def test_reasoning_level_none_for_non_reasoning_model(self):
        from openai_compat.views import _build_params

        class FakeRequest:
            data = {'reasoning_level': 'high'}

        class FakeModel:
            is_reasoning = False

        messages = [{'role': 'user', 'content': 'Hi'}]

        params = _build_params(FakeRequest(), FakeModel(), messages)

        self.assertIsNone(params['reasoning_level'])

    def test_reasoning_level_set_for_reasoning_model(self):
        from openai_compat.views import _build_params

        class FakeRequest:
            data = {'reasoning_level': 'high'}

        class FakeModel:
            is_reasoning = True

        messages = [{'role': 'user', 'content': 'Hi'}]

        params = _build_params(FakeRequest(), FakeModel(), messages)

        self.assertEqual(params['reasoning_level'], 'high')

    def test_invalid_reasoning_level_defaults_to_none(self):
        from openai_compat.views import _build_params

        class FakeRequest:
            data = {'reasoning_level': 'invalid'}

        class FakeModel:
            is_reasoning = True

        messages = [{'role': 'user', 'content': 'Hi'}]

        params = _build_params(FakeRequest(), FakeModel(), messages)

        self.assertIsNone(params['reasoning_level'])


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class OpenAICompatModelResolutionTests(TestCase):
    """Test model resolution."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123',
            email='test@example.com',
        )
        self.client.force_authenticate(user=self.user)
        from decimal import Decimal
        from sandbox.services.workspace_auth import personal_workspace
        _ws = personal_workspace(self.user)
        from sandbox.tests.byok_helpers import add_workspace_key
        add_workspace_key(_ws, 'openai', 'sk-openai-workspace-key')
        add_workspace_key(_ws, 'openrouter')
        self.url = '/v1/chat/completions'

        self.author = User.objects.create_user(
            username='author', password='pass', email='author@example.com'
        )
        self.text_model = Model.objects.create(
            name='my-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='gpt-4',
            external_api_key='sk-test',
            external_url='https://api.openai.com/v1',
            input_price=0,
            output_price=0,
        )

    @patch('chat.services.chat_service.OpenAI')
    def test_resolves_model_by_name(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.choices = [SimpleNamespace(
            message=SimpleNamespace(content='Response')
        )]
        mock_response.usage = SimpleNamespace(prompt_tokens=5, completion_tokens=5)
        mock_client.chat.completions.create.return_value = mock_response

        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'my-model',
                'messages': [{'role': 'user', 'content': 'Hi'}],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)

    def test_model_not_found_returns_404(self):
        response = self.client.post(
            self.url,
            data=json.dumps({
                'model': 'nonexistent-model-name',
                'messages': [{'role': 'user', 'content': 'Hi'}],
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 404)


@override_settings(DEFAULT_FILE_STORAGE='django.core.files.storage.InMemoryStorage')
class OpenAICompatServiceTests(TestCase):
    """Test the OpenAIChatService class directly."""

    def setUp(self):
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123',
            email='test@example.com',
        )
        self.author = User.objects.create_user(
            username='author', password='pass', email='author@example.com'
        )
        self.text_model = Model.objects.create(
            name='test-model',
            model_type='text',
            author=self.author,
            is_external=True,
            external_model_id='gpt-4',
            external_api_key='sk-test',
            external_url='https://api.openai.com/v1',
        )
        self.conversation = Conversation.objects.create(user=self.user)
        self.request_obj = Request.objects.create(
            model=self.text_model,
            status='processing',
            conversation=self.conversation,
            user=self.user,
            parent=None,
        )

    def test_build_messages_returns_params_messages(self):
        from openai_compat.services.openai_chat_completions import OpenAIChatService

        messages = [
            {'role': 'system', 'content': 'You are helpful'},
            {'role': 'user', 'content': 'Hi'},
        ]
        params = {
            'messages': messages,
            'temperature': 0.7,
            'top_p': 0.9,
            'system_prompt': None,
            'reasoning_level': None,
            'attachments_context': '',
            'user_msg': SimpleNamespace(content='Hi'),
        }

        service = OpenAIChatService(self.text_model, self.conversation, self.request_obj, params)

        self.assertEqual(service._build_messages(), messages)

    def test_ensure_title_returns_empty_string(self):
        from openai_compat.services.openai_chat_completions import OpenAIChatService

        params = {
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'temperature': 0.7,
            'top_p': 0.9,
            'system_prompt': None,
            'reasoning_level': None,
            'attachments_context': '',
            'user_msg': SimpleNamespace(content='Hi'),
        }

        service = OpenAIChatService(self.text_model, self.conversation, self.request_obj, params)

        self.assertEqual(service._ensure_title(), '')

    def test_save_response_does_not_create_message(self):
        from chat.models import Message

        from openai_compat.services.openai_chat_completions import OpenAIChatService

        params = {
            'messages': [{'role': 'user', 'content': 'Hi'}],
            'temperature': 0.7,
            'top_p': 0.9,
            'system_prompt': None,
            'reasoning_level': None,
            'attachments_context': '',
            'user_msg': SimpleNamespace(content='Hi'),
        }

        service = OpenAIChatService(self.text_model, self.conversation, self.request_obj, params)

        initial_message_count = Message.objects.count()

        result = service._save_response(
            'Test response',
            input_tokens=10,
            output_tokens=20,
        )

        self.assertEqual(Message.objects.count(), initial_message_count)
        self.assertEqual(result['response'], 'Test response')
        self.assertEqual(result['input_tokens'], 10)
        self.assertEqual(result['output_tokens'], 20)

        self.request_obj.refresh_from_db()
        self.assertEqual(self.request_obj.status, 'completed')
        self.assertEqual(self.request_obj.input_tokens, 10)
        self.assertEqual(self.request_obj.output_tokens, 20)
