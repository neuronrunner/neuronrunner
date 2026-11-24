from unittest.mock import Mock, patch
from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from model.models import Model
from sandbox.models import Workspace, WorkspaceMembership, WorkspaceProviderKey
from sandbox.services.provider_keys import cipher, credentials_for_request

User = get_user_model()


class CustomModelsAPITest(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='model-owner', email='owner@example.com', password='password123')
        self.member = User.objects.create_user(username='model-member', email='member@example.com', password='password123')
        self.stranger = User.objects.create_user(username='model-stranger', email='stranger@example.com', password='password123')

        self.workspace = Workspace.objects.create(name='AI Team', slug='ai-team', owner=self.owner)
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.owner, role='owner')
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.member, role='member')

        # Add an openrouter provider key
        key_secret = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz123456'
        self.key = WorkspaceProviderKey.objects.create(
            workspace=self.workspace,
            provider='openrouter',
            encrypted_key=cipher().encrypt(key_secret.encode()).decode(),
            last4=key_secret[-4:],
            created_by=self.owner,
        )

        self.client = APIClient()
        self.url = f'/sandbox/workspaces/{self.workspace.pk}/custom-models/'
        self.test_url = f'/sandbox/workspaces/{self.workspace.pk}/custom-models/test/'

    def test_owner_can_add_custom_model_with_key_id(self):
        self.client.force_authenticate(user=self.owner)
        payload = {
            'key_id': str(self.key.pk),
            'display_name': 'Claude 3.7 Sonnet Keybound',
            'external_model_id': 'anthropic/claude-3.7-sonnet',
            'context_length': 200000,
            'max_tokens': 8192,
            'is_reasoning': True,
            'supports_tools': True,
        }
        res = self.client.post(self.url, payload)
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data['provider'], 'openrouter')
        self.assertEqual(res.data['provider_key']['uuid'], str(self.key.pk))

        model_obj = Model.objects.get(name=res.data['name'])
        self.assertEqual(model_obj.provider_key, self.key)
        self.assertEqual(model_obj.workspace, self.workspace)

    def test_member_can_list_custom_models(self):
        self.client.force_authenticate(user=self.member)
        res = self.client.get(self.url)
        self.assertEqual(res.status_code, 200)
        self.assertIn('models', res.data)
        self.assertEqual(len(res.data['models']), 0)
        self.assertIn('openrouter', res.data['configured_providers'])

    def test_non_member_cannot_access_custom_models(self):
        self.client.force_authenticate(user=self.stranger)
        res = self.client.get(self.url)
        self.assertEqual(res.status_code, 404)

    def test_owner_can_add_custom_model(self):
        self.client.force_authenticate(user=self.owner)
        payload = {
            'provider': 'openrouter',
            'display_name': 'Claude 3.7 Sonnet',
            'external_model_id': 'anthropic/claude-3.7-sonnet',
            'context_length': 200000,
            'max_tokens': 8192,
            'is_reasoning': True,
            'supports_tools': True,
        }
        res = self.client.post(self.url, payload)
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data['display_name'], 'Claude 3.7 Sonnet')
        self.assertTrue(res.data['is_reasoning'])
        self.assertEqual(res.data['context_length'], 200000)

        # Verify database model
        model_obj = Model.objects.get(name=res.data['name'])
        self.assertEqual(model_obj.workspace, self.workspace)
        self.assertEqual(model_obj.external_model_id, 'anthropic/claude-3.7-sonnet')
        self.assertEqual(model_obj.llm_config.context_length, 200000)
        self.assertTrue(model_obj.llm_config.supports_tools)

    def test_member_cannot_add_custom_model(self):
        self.client.force_authenticate(user=self.member)
        payload = {
            'provider': 'openrouter',
            'display_name': 'Llama 3.3 70B',
            'external_model_id': 'meta-llama/llama-3.3-70b-instruct',
        }
        res = self.client.post(self.url, payload)
        self.assertEqual(res.status_code, 403)

    def test_owner_can_delete_custom_model(self):
        self.client.force_authenticate(user=self.owner)
        # Create a custom model first
        res = self.client.post(self.url, {
            'provider': 'openrouter',
            'display_name': 'To Delete',
            'external_model_id': 'delete/me',
        })
        model_name = res.data['name']

        # Delete it
        del_res = self.client.delete(f"{self.url}{model_name}/")
        self.assertEqual(del_res.status_code, 204)
        self.assertFalse(Model.objects.filter(name=model_name).exists())

    @patch('httpx.Client.post')
    def test_test_custom_model_success(self, mock_post):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.is_redirect = False
        mock_post.return_value = mock_resp

        self.client.force_authenticate(user=self.owner)
        res = self.client.post(self.test_url, {
            'provider': 'openrouter',
            'external_model_id': 'anthropic/claude-3.7-sonnet',
        })
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.data['success'])
        self.assertIn('latency_ms', res.data)

    def test_custom_endpoint_with_base_url(self):
        self.client.force_authenticate(user=self.owner)
        # Save custom provider with base_url
        key_url = f'/sandbox/workspaces/{self.workspace.pk}/provider-keys/'
        self.client.put(key_url, {
            'provider': 'custom',
            'base_url': 'http://localhost:11434/v1',
            'api_key': '',
        })

        # Add custom model for that custom provider
        res = self.client.post(self.url, {
            'provider': 'custom',
            'display_name': 'Local Ollama Llama 3',
            'external_model_id': 'llama3.3:latest',
        })
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data['provider'], 'custom')

        model_obj = Model.objects.get(name=res.data['name'])
        self.assertEqual(model_obj.external_url, 'http://localhost:11434/v1')

    def test_custom_model_persists_reasoning_mode_and_tiers(self):
        self.client.force_authenticate(user=self.owner)
        res = self.client.post(self.url, {
            'provider': 'openrouter',
            'display_name': 'Qwen Custom Tiered',
            'external_model_id': 'qwen/qwen3.8-max',
            'is_reasoning': True,
            'reasoning_mode': 'effort',
            'supported_reasoning_efforts': ['minimal', 'low', 'medium', 'high', 'xhigh'],
            'default_reasoning_effort': 'high',
        }, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data['reasoning_mode'], 'effort')
        self.assertEqual(res.data['reasoning_tiers'], ['minimal', 'low', 'medium', 'high', 'xhigh'])
        self.assertEqual(res.data['default_reasoning_effort'], 'high')

        model_obj = Model.objects.select_related('llm_config').get(name=res.data['name'])
        self.assertEqual(model_obj.llm_config.reasoning_mode, 'effort')
        self.assertEqual(
            model_obj.llm_config.supported_reasoning_efforts,
            ['minimal', 'low', 'medium', 'high', 'xhigh'],
        )
        self.assertEqual(model_obj.llm_config.default_reasoning_effort, 'high')
