"""Every LLM call runs on the workspace's own key or subscription; server keys never pay."""
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from chat.models import Conversation, Message
from chat.services.chat_service import ChatService
from chat.views.predict import _create_request
from model.models import Model
from sandbox.models import Sandbox, Workspace, WorkspaceMembership, WorkspaceProviderKey
from sandbox.services.provider_keys import ProviderKeyRequired, auxiliary_target
from sandbox.tests.byok_helpers import add_workspace_key

User = get_user_model()


@override_settings(OPENROUTER_API_KEY='server-key', OPENAI_API_KEY='server-openai-key')
class BYOKOnlyTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username='catalog-admin', email='admin@example.com', password='pw-123456')
        self.owner = User.objects.create_user(username='owner', email='owner@example.com', password='pw-123456')
        self.member = User.objects.create_user(username='member', email='member@example.com', password='pw-123456')
        self.workspace = Workspace.objects.create(name='Team', slug='team', owner=self.owner)
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.owner, role='owner')
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.member, role='member')
        self.openrouter_model = self._model('or-model')
        self.openai_model = self._model('oa-model', provider='openai', url='https://api.openai.com/v1')
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _model(self, name, provider='openrouter', url='https://openrouter.ai/api/v1', workspace=None):
        return Model.objects.create(
            name=name,
            display_name=name,
            model_type='text',
            source=Model.SOURCE_EXTERNAL,
            status=Model.STATUS_ACTIVE,
            is_external=True,
            is_public=workspace is None,
            workspace=workspace,
            provider_name=provider,
            external_url=url,
            external_model_id=f'vendor/{name}',
            external_api_key='server-key',
            input_price=Decimal('1.00'),
            output_price=Decimal('2.00'),
            author=self.admin,
        )

    def _add_key(self, provider='openrouter', secret='sk-or-test-key-123'):
        return add_workspace_key(self.workspace, provider, secret, user=self.owner)

    def _conversation(self):
        conversation = Conversation.objects.create(user=self.owner, workspace=self.workspace)
        message = Message.objects.create(conversation=conversation, role='user', content='Hello there')
        return conversation, message

    def _model_names(self):
        response = self.client.get('/models/', HTTP_X_WORKSPACE_ID=str(self.workspace.pk))
        self.assertEqual(response.status_code, 200)
        return {m['name'] for m in response.data.get('results', response.data)}

    def _service(self, request, model):
        service = ChatService.__new__(ChatService)
        service.current_request = request
        service.conversation = request.conversation
        service.model_tag = model
        service.model = model
        return service

    # --- requests -----------------------------------------------------------

    def test_request_without_workspace_key_is_rejected(self):
        conversation, message = self._conversation()
        with self.assertRaises(ProviderKeyRequired):
            _create_request(self.openrouter_model, conversation, self.owner, message, {}, stream=True)

    def test_predict_endpoint_returns_provider_key_required(self):
        response = self.client.post(
            f'/predict/{self.openrouter_model.name}/',
            {'content': 'Hello'},
            format='json',
            HTTP_X_WORKSPACE_ID=str(self.workspace.pk),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['detail'].code, 'provider_key_required')
        self.assertFalse(Message.objects.filter(content='Hello').exists())

    def test_request_with_workspace_key_uses_byok(self):
        self._add_key('openrouter')
        conversation, message = self._conversation()
        request = _create_request(self.openrouter_model, conversation, self.owner, message, {}, stream=True)
        self.assertTrue(request.uses_byok)
        self.assertEqual(request.provider, 'openrouter')

    # --- model lists --------------------------------------------------------

    def test_model_list_only_shows_models_the_workspace_can_pay_for(self):
        self.assertEqual(self._model_names() & {'or-model', 'oa-model'}, set())
        self._add_key('openrouter')
        names = self._model_names()
        self.assertIn('or-model', names)
        self.assertNotIn('oa-model', names)

    def test_recent_models_skip_models_without_key(self):
        self._add_key('openrouter')
        conversation, message = self._conversation()
        _create_request(self.openrouter_model, conversation, self.owner, message, {}, stream=True)
        WorkspaceProviderKey.objects.filter(workspace=self.workspace).delete()
        response = self.client.get('/recent-models/', HTTP_X_WORKSPACE_ID=str(self.workspace.pk))
        self.assertEqual(response.data, [])

    def test_llm_setup_reports_usable_models(self):
        url = f'/sandbox/workspaces/{self.workspace.pk}/llm-setup/'
        data = self.client.get(url).data
        self.assertTrue(data['can_manage'])
        self.assertEqual(data['usable_model_count'], 0)
        self.assertIsNone(data['auxiliary_model'])

        self._add_key('openai', 'sk-openai-test-123')
        data = self.client.get(url).data
        self.assertEqual(data['configured_providers'], ['openai'])
        self.assertEqual(data['usable_model_count'], 1)
        self.assertEqual(data['usable_models'][0]['name'], 'oa-model')

        self.client.force_authenticate(self.member)
        self.assertFalse(self.client.get(url).data['can_manage'])

    # --- auxiliary model ----------------------------------------------------

    def test_auxiliary_model_can_be_set_and_cleared_by_admins(self):
        self._add_key('openrouter')
        url = f'/sandbox/workspaces/{self.workspace.pk}/llm-setup/'
        data = self.client.put(url, {'auxiliary_model': 'or-model'}, format='json').data
        self.assertEqual(data['auxiliary_model'], {'name': 'or-model', 'display_name': 'or-model', 'usable': True})
        self.workspace.refresh_from_db()
        self.assertEqual(self.workspace.auxiliary_model, self.openrouter_model)

        # A model no key of this workspace covers is refused.
        self.assertEqual(self.client.put(url, {'auxiliary_model': 'oa-model'}, format='json').status_code, 400)

        self.client.force_authenticate(self.member)
        self.assertEqual(self.client.put(url, {'auxiliary_model': None}, format='json').status_code, 403)
        self.client.force_authenticate(self.owner)
        self.assertIsNone(self.client.put(url, {'auxiliary_model': None}, format='json').data['auxiliary_model'])

    def test_auxiliary_target_prefers_auxiliary_model_then_chat_model(self):
        self._add_key('openrouter', 'sk-or-user-key-999')
        cheap = self._model('cheap', workspace=self.workspace)
        self.assertEqual(auxiliary_target(self.workspace, chat_model=self.openrouter_model), {
            'api_key': 'sk-or-user-key-999',
            'base_url': 'https://openrouter.ai/api/v1',
            'model': 'vendor/or-model',
        })
        self.workspace.auxiliary_model = cheap
        self.assertEqual(auxiliary_target(self.workspace, chat_model=self.openrouter_model)['model'], 'vendor/cheap')
        # Never the server key: no workspace key covers OpenAI.
        self.workspace.auxiliary_model = None
        self.assertIsNone(auxiliary_target(self.workspace, chat_model=self.openai_model))

    def test_byos_subscription_cannot_serve_side_calls(self):
        add_workspace_key(self.workspace, 'anthropic_sub', '', user=self.owner)
        byos = self._model('byos-claude', provider='anthropic_sub', url='', workspace=self.workspace)
        self.assertIsNone(auxiliary_target(self.workspace, chat_model=byos))

    # --- side calls in a chat -----------------------------------------------

    def test_chat_service_side_calls_use_workspace_credentials(self):
        self._add_key('openrouter', 'sk-or-user-key-999')
        conversation, message = self._conversation()
        request = _create_request(self.openrouter_model, conversation, self.owner, message, {}, stream=True)
        target = self._service(request, self.openrouter_model)._auxiliary_llm_target()
        self.assertEqual(target['api_key'], 'sk-or-user-key-999')
        self.assertEqual(target['model'], 'vendor/or-model')

    def test_byos_chat_has_no_side_call_target(self):
        # Titles then fall back to the message (see test_title_generation).
        add_workspace_key(self.workspace, 'anthropic_sub', '', user=self.owner)
        byos = self._model('byos-claude', provider='anthropic_sub', url='', workspace=self.workspace)
        conversation, message = self._conversation()
        request = SimpleNamespace(parent=message, uuid='r', uses_byok=True, workspace=self.workspace, conversation=conversation)
        self.assertIsNone(self._service(request, byos)._auxiliary_llm_target())

    def test_memory_job_skips_without_workspace_key(self):
        add_workspace_key(self.workspace, 'anthropic_sub', '', user=self.owner)
        byos = self._model('byos-claude', provider='anthropic_sub', url='', workspace=self.workspace)
        conversation, message = self._conversation()
        request = SimpleNamespace(user=self.owner, workspace=self.workspace, conversation=conversation)
        service = self._service(request, byos)
        service.user_msg = message
        with patch('chat.services.memory_extraction.extract_memories') as extract:
            service._start_memory_job()
        extract.assert_not_called()

    def test_project_suggestions_use_auxiliary_model_or_fall_back(self):
        from sandbox.views import generate_project_suggestions

        project = Sandbox.objects.create(
            user=self.owner, workspace=self.workspace, slug='app', display_name='App', filesystem_path='/workspace/app',
        )
        with patch('sandbox.views.OpenAI') as mock_openai, \
                patch('sandbox.views._get_fallback_suggestions', return_value=['fallback']):
            self.assertEqual(generate_project_suggestions(project), ['fallback'])
            mock_openai.assert_not_called()

            self._add_key('openrouter', 'sk-or-user-key-999')
            self.workspace.auxiliary_model = self.openrouter_model
            self.workspace.save()
            project.workspace.refresh_from_db()
            mock_openai.return_value.chat.completions.create.side_effect = RuntimeError('offline')
            generate_project_suggestions(project)
        self.assertEqual(mock_openai.call_args.kwargs['api_key'], 'sk-or-user-key-999')
        self.assertEqual(mock_openai.return_value.chat.completions.create.call_args.kwargs['model'], 'vendor/or-model')

    # --- provider model listing ---------------------------------------------

    def test_remote_models_lists_text_models_with_prices(self):
        self._add_key('openrouter')
        key_ok = Mock(status_code=200)
        listing = Mock(status_code=200)
        listing.json.return_value = {'data': [
            {'id': 'b/text', 'name': 'B Text', 'context_length': 8000,
             'architecture': {'input_modalities': ['text', 'image'], 'output_modalities': ['text']},
             'supported_parameters': ['tools'], 'pricing': {'prompt': '0.00000015', 'completion': '0.0000006'}},
            {'id': 'c/free:free', 'name': 'C Free', 'pricing': {'prompt': '0', 'completion': '0'}},
            {'id': 'a/image', 'name': 'A Image', 'architecture': {'output_modalities': ['image']}},
        ]}
        with patch('httpx.Client') as client_cls:
            client_cls.return_value.__enter__.return_value.get.side_effect = [key_ok, listing]
            response = self.client.post(
                f'/sandbox/workspaces/{self.workspace.pk}/provider-keys/remote-models/',
                {'provider': 'openrouter'},
                format='json',
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['models'], [
            {'id': 'b/text', 'name': 'B Text', 'context_length': 8000, 'supports_vision': True,
             'supports_tools': True, 'is_reasoning': False, 'prompt_price': 0.15, 'completion_price': 0.6,
             'is_free': False},
            {'id': 'c/free:free', 'name': 'C Free', 'context_length': None, 'supports_vision': False,
             'supports_tools': None, 'is_reasoning': None, 'prompt_price': 0.0, 'completion_price': 0.0,
             'is_free': True},
        ])
        get = client_cls.return_value.__enter__.return_value.get
        self.assertEqual(get.call_args.kwargs['headers']['Authorization'], 'Bearer sk-or-test-key-123')

    def test_remote_models_reports_rejected_key(self):
        self._add_key('openai', 'sk-openai-bad-123')
        with patch('httpx.Client') as client_cls:
            client_cls.return_value.__enter__.return_value.get.return_value = Mock(status_code=401)
            response = self.client.post(
                f'/sandbox/workspaces/{self.workspace.pk}/provider-keys/remote-models/',
                {'provider': 'openai'},
                format='json',
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn('rejected', response.data['error'])

    def test_remote_models_checks_openrouter_key_before_public_list(self):
        self._add_key('openrouter')
        with patch('httpx.Client') as client_cls:
            get = client_cls.return_value.__enter__.return_value.get
            get.return_value = Mock(status_code=401)
            response = self.client.post(
                f'/sandbox/workspaces/{self.workspace.pk}/provider-keys/remote-models/',
                {'provider': 'openrouter'},
                format='json',
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(get.call_count, 1)
        self.assertTrue(get.call_args.args[0].endswith('/key'))

    def test_remote_models_requires_admin(self):
        self._add_key('openrouter')
        self.client.force_authenticate(self.member)
        response = self.client.post(
            f'/sandbox/workspaces/{self.workspace.pk}/provider-keys/remote-models/',
            {'provider': 'openrouter'},
            format='json',
        )
        self.assertEqual(response.status_code, 403)
