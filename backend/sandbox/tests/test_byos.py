from datetime import timedelta
from decimal import Decimal
import io
import json
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from chat.models import Conversation, Message, Request
from chat.services.byos_runner import (
    build_byos_prompt,
    is_byos_model,
    normalize_byos_line,
    stream_byos_cli,
)
from chat.services.chat_service import ChatService
from chat.views.predict import _create_request
from model.models import Model
from model.serializers import ModelSerializer
from sandbox.models import Workspace, WorkspaceMembership, WorkspaceProviderKey
from sandbox.services.provider_keys import cipher, credentials_for_request

User = get_user_model()


class _FakeVMProcess:
    def __init__(self, stdout_lines, stderr_text='', exit_code=0):
        self.stdout = stdout_lines
        self.stderr = io.BytesIO(stderr_text.encode('utf-8')) if stderr_text else None
        self._exit_code = exit_code

    def wait(self, timeout=None):
        return self._exit_code

    def kill(self):
        pass


def _fake_live_models(provider: str, _secret: str = '', *, runtime=None):
    if provider == 'anthropic_sub':
        return [
            {
                'slug_suffix': 'byos-claude-sonnet-4-6',
                'display_name': 'Claude Sonnet 4.6',
                'external_model_id': 'claude-sonnet-4-6',
                'supports_vision': True,
                'supports_tools': True,
                'is_reasoning': True,
                'context_length': 200000,
                'max_tokens': 16384,
            },
            {
                'slug_suffix': 'byos-claude-opus-4-6',
                'display_name': 'Claude Opus 4.6',
                'external_model_id': 'claude-opus-4-6',
                'supports_vision': True,
                'supports_tools': True,
                'is_reasoning': True,
                'context_length': 200000,
                'max_tokens': 16384,
            },
        ], None
    if provider == 'openai_sub':
        return [
            {
                'slug_suffix': 'byos-gpt-5-4-codex',
                'display_name': 'GPT-5.4 Codex',
                'external_model_id': 'gpt-5.4',
                'supports_vision': True,
                'supports_tools': True,
                'is_reasoning': True,
                'context_length': 200000,
                'max_tokens': 16384,
            },
            {
                'slug_suffix': 'byos-codex-mini',
                'display_name': 'Codex Mini',
                'external_model_id': 'codex-mini-latest',
                'supports_vision': False,
                'supports_tools': True,
                'is_reasoning': True,
                'context_length': 200000,
                'max_tokens': 16384,
            },
        ], None
    if provider == 'antigravity_sub':
        return [
            {
                'slug_suffix': 'byos-antigravity-gemini-4-argon-medium',
                'display_name': 'Gemini 4 Argon (Medium)',
                'external_model_id': 'gemini-4-argon-medium',
                'supports_vision': True,
                'supports_tools': True,
                'is_reasoning': True,
                'context_length': 1000000,
                'max_tokens': 16384,
            },
        ], None
    return [], None


@override_settings(CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}, SECURE_SSL_REDIRECT=False)
class BYOSSystemTests(TestCase):
    def setUp(self):
        self._live_models_patcher = patch(
            'sandbox.services.byos_models.fetch_live_byos_models_with_status',
            side_effect=_fake_live_models,
        )
        self._live_models_patcher.start()
        self.addCleanup(self._live_models_patcher.stop)

        self.owner = User.objects.create_user(
            username='byos-owner',
            email='byos-owner@example.com',
            password='password123',
        )
        self.member = User.objects.create_user(
            username='byos-member',
            email='byos-member@example.com',
            password='password123',
        )
        self.workspace = Workspace.objects.create(
            name='BYOS Team',
            slug='byos-team',
            owner=self.owner,
        )
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.owner, role='owner')
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.member, role='member')

        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.keys_url = f'/sandbox/workspaces/{self.workspace.pk}/provider-keys/'
        self.sync_url = f'/sandbox/workspaces/{self.workspace.pk}/provider-keys/sync-from-vm/'
        self.test_url = f'/sandbox/workspaces/{self.workspace.pk}/custom-models/test/'

    def _connect_vm_provider(self, provider: str):
        fake_proc = _FakeVMProcess(stdout_lines=io.StringIO(json.dumps({'present': True, 'path': f'/root/.{provider}'})))
        fake_runtime = Mock()
        fake_runtime.exec.return_value = fake_proc
        fake_manager = Mock()
        fake_manager.get_or_create.return_value = fake_runtime
        with patch('sandbox.services.sandbox_session.get_sandbox_manager', return_value=fake_manager):
            return self.client.post(self.sync_url, {'provider': provider})

    def test_connect_and_disconnect_byos_providers_syncs_models_without_storing_tokens(self):
        # Raw OAuth token uploads via PUT /provider-keys/ must be rejected so credentials stay on the VM.
        raw_res = self.client.put(self.keys_url, {'provider': 'anthropic_sub', 'api_key': 'sk-ant-oat01-test-claude-subscription-token-123456'})
        self.assertEqual(raw_res.status_code, 400)

        res = self._connect_vm_provider('anthropic_sub')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['auth_type'], 'subscription')
        self.assertEqual(res.data['masked_key'], '(VM session)')

        key_obj = WorkspaceProviderKey.objects.get(workspace=self.workspace, provider='anthropic_sub')
        self.assertEqual(key_obj.encrypted_key, '')
        self.assertEqual(key_obj.last4, 'VM')

        claude_models = list(
            Model.objects.filter(workspace=self.workspace, provider_name='anthropic_sub').order_by('external_model_id')
        )
        self.assertEqual(len(claude_models), 2)
        self.assertEqual(
            sorted(m.external_model_id for m in claude_models),
            ['claude-opus-4-6', 'claude-sonnet-4-6'],
        )
        serialized = ModelSerializer(claude_models[0]).data
        self.assertTrue(serialized['is_byos'])
        self.assertTrue(serialized['is_byok'])

        # Connect OpenAI Codex via VM session verification
        res_codex = self._connect_vm_provider('openai_sub')
        self.assertEqual(res_codex.status_code, 200, res_codex.data)
        self.assertEqual(res_codex.data['masked_key'], '(VM session)')

        codex_models = list(Model.objects.filter(workspace=self.workspace, provider_name='openai_sub'))
        self.assertEqual(len(codex_models), 2)

        # Verify TestCustomModel endpoint accepts connected VM-only BYOS models cleanly
        test_res = self.client.post(self.test_url, {
            'provider': 'anthropic_sub',
            'external_model_id': 'claude-sonnet-4-6',
        })
        self.assertEqual(test_res.status_code, 200)
        self.assertTrue(test_res.data['success'])

        # Deleting provider key removes auto-provisioned BYOS models
        del_res = self.client.delete(self.keys_url, {'provider': 'anthropic_sub'})
        self.assertEqual(del_res.status_code, 204)
        self.assertFalse(Model.objects.filter(workspace=self.workspace, provider_name='anthropic_sub').exists())
        self.assertTrue(Model.objects.filter(workspace=self.workspace, provider_name='openai_sub').exists())

    def test_rejects_raw_byos_secret_uploads(self):
        res = self.client.put(self.keys_url, {'provider': 'openai_sub', 'api_key': '{invalid-json'})
        self.assertEqual(res.status_code, 400)

        res_empty = self.client.put(self.keys_url, {'provider': 'anthropic_sub', 'api_key': 'sk-ant-oat01-token-123456'})
        self.assertEqual(res_empty.status_code, 400)

    def test_sync_from_vm_verifies_presence_without_extracting_or_storing_tokens(self):
        fake_proc = _FakeVMProcess(
            stdout_lines=io.StringIO(json.dumps({
                'present': True,
                'path': '/root/.claude/.credentials.json',
            }))
        )
        fake_runtime = Mock()
        fake_runtime.exec.return_value = fake_proc
        fake_manager = Mock()
        fake_manager.get_or_create.return_value = fake_runtime

        with patch('sandbox.services.sandbox_session.get_sandbox_manager', return_value=fake_manager):
            res = self.client.post(self.sync_url, {'provider': 'anthropic_sub'})

        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['provider'], 'anthropic_sub')
        self.assertEqual(res.data['auth_type'], 'subscription')
        self.assertEqual(res.data['masked_key'], '(VM session)')
        key_obj = WorkspaceProviderKey.objects.get(workspace=self.workspace, provider='anthropic_sub')
        self.assertEqual(key_obj.encrypted_key, '')
        exec_script = fake_runtime.exec.call_args[0][2]
        self.assertNotIn('read_bytes', exec_script)
        self.assertNotIn('read_text', exec_script)
        self.assertTrue(Model.objects.filter(workspace=self.workspace, provider_name='anthropic_sub').exists())

    def test_sync_from_vm_reports_missing_credentials(self):
        fake_proc = _FakeVMProcess(stdout_lines=io.StringIO(json.dumps({'present': False})))
        fake_runtime = Mock()
        fake_runtime.exec.return_value = fake_proc
        fake_manager = Mock()
        fake_manager.get_or_create.return_value = fake_runtime

        with patch('sandbox.services.sandbox_session.get_sandbox_manager', return_value=fake_manager):
            res = self.client.post(self.sync_url, {'provider': 'openai_sub'})

        self.assertEqual(res.status_code, 400)
        self.assertIn('codex login', res.data['error'])

    def test_byos_credentials_return_byos_endpoint(self):
        self._connect_vm_provider('anthropic_sub')
        byos_model = Model.objects.filter(workspace=self.workspace, provider_name='anthropic_sub').first()
        conversation = Conversation.objects.create(user=self.owner, workspace=self.workspace)
        user_msg = Message.objects.create(conversation=conversation, role='user', content='Hello CLI')

        req = _create_request(byos_model, conversation, self.owner, user_msg, {}, stream=True)
        self.assertTrue(req.uses_byok)
        self.assertEqual(req.provider, 'anthropic_sub')

        secret, endpoint = credentials_for_request(byos_model, req)
        self.assertEqual(secret, '')
        self.assertEqual(endpoint, 'byos://anthropic_sub')

    def test_normalize_byos_line_claude_and_codex(self):
        claude_events = normalize_byos_line(
            'anthropic_sub',
            json.dumps({
                'type': 'assistant',
                'message': {
                    'content': [
                        {'type': 'thinking', 'thinking': 'Checking repo'},
                        {'type': 'tool_use', 'id': 'tu_1', 'name': 'Read', 'input': {'file_path': 'README.md'}},
                        {'type': 'text', 'text': 'Done reading.'},
                    ],
                    'usage': {'input_tokens': 120, 'output_tokens': 35, 'cache_read_input_tokens': 80},
                },
            }),
        )
        self.assertEqual(
            [e['kind'] for e in claude_events],
            ['thinking', 'tool_call', 'text', 'usage'],
        )
        self.assertEqual(claude_events[1]['name'], 'Read')

        claude_tool_res = normalize_byos_line(
            'anthropic_sub',
            json.dumps({
                'type': 'user',
                'message': {
                    'content': [
                        {'type': 'tool_result', 'tool_use_id': 'tu_1', 'content': 'file body', 'is_error': False},
                    ],
                },
            }),
        )
        self.assertEqual(claude_tool_res[0]['kind'], 'tool_result')
        self.assertEqual(claude_tool_res[0]['result']['output'], 'file body')

        codex_start = normalize_byos_line(
            'openai_sub',
            json.dumps({
                'type': 'item.started',
                'item': {'id': 'cmd_1', 'type': 'command_execution', 'command': 'pytest', 'status': 'in_progress'},
            }),
        )
        self.assertEqual(codex_start[0]['kind'], 'tool_call')
        self.assertEqual(codex_start[0]['name'], 'shell_exec')

        codex_done = normalize_byos_line(
            'openai_sub',
            json.dumps({
                'type': 'item.completed',
                'item': {
                    'id': 'cmd_1',
                    'type': 'command_execution',
                    'command': 'pytest',
                    'aggregated_output': '2 passed',
                    'exit_code': 0,
                    'status': 'completed',
                },
            }),
        )
        self.assertEqual([e['kind'] for e in codex_done], ['tool_call', 'tool_result'])
        self.assertEqual(codex_done[1]['result']['output'], '2 passed')

        codex_msg = normalize_byos_line(
            'openai_sub',
            json.dumps({
                'type': 'item.completed',
                'item': {'id': 'msg_1', 'type': 'agent_message', 'text': 'All green.'},
            }),
        )
        self.assertEqual(codex_msg, [{'kind': 'text', 'text': 'All green.'}])

        codex_ws = normalize_byos_line(
            'openai_sub',
            json.dumps({
                'type': 'item.completed',
                'item': {
                    'id': 'ws_1',
                    'type': 'web_search',
                    'query': 'Elon Musk latest news',
                    'action': {'type': 'search', 'query': 'Elon Musk latest news'},
                    'results': [
                        {'type': 'text_result', 'title': 'AP Story', 'url': 'https://apnews.com/1', 'snippet': 'News body'}
                    ],
                },
            }),
        )
        self.assertEqual([e['kind'] for e in codex_ws], ['tool_call', 'tool_result'])
        self.assertEqual(json.loads(codex_ws[0]['arguments']), {'query': 'Elon Musk latest news'})
        self.assertEqual(
            codex_ws[1]['result'],
            {
                'status': 'ok',
                'query': 'Elon Musk latest news',
                'count': 1,
                'results': [{'title': 'AP Story', 'url': 'https://apnews.com/1', 'snippet': 'News body'}],
            },
        )

    def test_normalize_byos_line_antigravity_stream_json(self):
        agy_delta = normalize_byos_line(
            'antigravity_sub',
            json.dumps({
                'event': 'step_update',
                'step_update': {
                    'step_index': 1,
                    'state': 'ACTIVE',
                    'step_type': 'agent_response',
                    'text_delta': 'Merhaba',
                },
            }),
        )
        self.assertEqual(agy_delta, [{'kind': 'text', 'text': 'Merhaba'}])

        agy_tool_done = normalize_byos_line(
            'antigravity_sub',
            json.dumps({
                'event': 'step_update',
                'step_update': {
                    'step_index': 2,
                    'state': 'DONE',
                    'step_type': 'tool',
                    'tool_name': 'run_command',
                    'tool_info': {'name': 'run_command', 'parameters': {'CommandLine': 'echo ok'}, 'output': 'ok'},
                },
            }),
        )
        self.assertEqual([e['kind'] for e in agy_tool_done], ['tool_call', 'tool_result'])
        self.assertEqual(agy_tool_done[0]['id'], 'agy_step_2')
        self.assertEqual(agy_tool_done[1]['result']['output'], 'ok')

        agy_result = normalize_byos_line(
            'antigravity_sub',
            json.dumps({
                'event': 'result',
                'result': {
                    'status': 'SUCCESS',
                    'response': 'Merhaba\n',
                    'usage': {'input_tokens': 100, 'output_tokens': 12, 'cache_read_tokens': 40},
                },
            }),
        )
        self.assertEqual(
            agy_result,
            [
                {'kind': 'usage', 'input_tokens': 100, 'output_tokens': 12, 'cached_tokens': 40},
                {'kind': 'result_fallback', 'text': 'Merhaba\n'},
            ],
        )

    def test_stream_byos_cli_translates_jsonl_to_sse(self):
        self._connect_vm_provider('openai_sub')
        byos_model = Model.objects.filter(workspace=self.workspace, provider_name='openai_sub').first()
        self.assertTrue(is_byos_model(byos_model))

        conversation = Conversation.objects.create(user=self.owner, workspace=self.workspace)
        user_msg = Message.objects.create(conversation=conversation, role='user', content='Fix tests')
        req = _create_request(byos_model, conversation, self.owner, user_msg, {}, stream=True)

        jsonl_lines = [
            json.dumps({'type': 'item.completed', 'item': {'id': 'r1', 'type': 'reasoning', 'text': 'Inspecting test suite'}}),
            json.dumps({'type': 'item.started', 'item': {'id': 'ws1', 'type': 'web_search', 'query': '', 'action': {'type': 'other'}}}),
            json.dumps({'type': 'item.completed', 'item': {'id': 'ws1', 'type': 'web_search', 'query': 'pytest docs', 'action': {'type': 'search', 'query': 'pytest docs'}, 'results': [{'title': 'Pytest', 'url': 'https://docs.pytest.org', 'snippet': 'Pytest docs'}]}}),
            json.dumps({'type': 'item.started', 'item': {'id': 'c1', 'type': 'command_execution', 'command': 'pytest'}}),
            json.dumps({'type': 'item.completed', 'item': {'id': 'c1', 'type': 'command_execution', 'command': 'pytest', 'aggregated_output': 'OK', 'exit_code': 0}}),
            json.dumps({'type': 'item.completed', 'item': {'id': 'm1', 'type': 'agent_message', 'text': 'Tests fixed!'}}),
            json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 250, 'cached_input_tokens': 100, 'output_tokens': 40}}),
        ]
        fake_proc = _FakeVMProcess(stdout_lines=[line + '\n' for line in jsonl_lines])
        fake_runtime = Mock()
        fake_runtime.exec.return_value = fake_proc
        fake_manager = Mock()
        fake_manager.get_or_create.return_value = fake_runtime

        chat_svc = SimpleNamespace(
            model_tag=byos_model,
            model=byos_model,
            conversation=conversation,
            current_request=req,
            messages=[{'role': 'user', 'content': 'Fix tests'}],
            system_prompt='Be concise.',
            attachments_context='',
            _resolve_reasoning_effort=lambda: 'high',
            _billed_input_tokens=0,
            _billed_output_tokens=0,
            _raise_if_canceled=Mock(),
            _append_stream_phase=ChatService._append_stream_phase,
            _update_partial_state=Mock(),
            _persist_token_snapshot=lambda input_tokens=0, output_tokens=0: Request.objects.filter(pk=req.pk).update(
                input_tokens=input_tokens, output_tokens=output_tokens
            ),
        )

        phases = []
        all_thinking = []
        all_tool_calls = []
        events = []
        with patch('sandbox.services.sandbox_session.get_sandbox_manager', return_value=fake_manager):
            gen = stream_byos_cli(chat_svc, phases, 1, all_thinking, all_tool_calls)
            while True:
                try:
                    events.append(next(gen))
                except StopIteration as stop:
                    full_response, full_thinking, in_tok, out_tok, next_tools, _dur = stop.value
                    break

        self.assertEqual(full_response, 'Tests fixed!')
        self.assertEqual(full_thinking, 'Inspecting test suite')
        self.assertEqual(in_tok, 250)
        self.assertEqual(out_tok, 40)
        self.assertEqual(next_tools, [])
        self.assertEqual(len(all_tool_calls), 2)
        self.assertEqual(json.loads(all_tool_calls[0]['function']['arguments']), {'query': 'pytest docs'})
        self.assertEqual(all_tool_calls[0]['result']['status'], 'ok')
        self.assertEqual(all_tool_calls[0]['result']['count'], 1)
        exec_args = fake_runtime.exec.call_args[0]
        decoded_payload = json.loads(__import__('base64').b64decode(exec_args[4]).decode('utf-8'))
        self.assertNotIn('secret', decoded_payload)
        self.assertEqual(decoded_payload['reasoning_effort'], 'high')
        self.assertIn("model_reasoning_effort={reasoning_effort}", exec_args[3])
        self.assertTrue(any('event: thinking' in e for e in events))
        self.assertTrue(any('event: tool_call' in e for e in events))
        self.assertTrue(any('event: tool_result' in e for e in events))
        self.assertTrue(any('event: message' in e for e in events))

    def test_build_byos_prompt_formats_history_cleanly(self):
        prompt = build_byos_prompt(
            [
                {'role': 'system', 'content': 'Internal API tool instructions to ignore'},
                {'role': 'user', 'content': 'Hi'},
                {'role': 'assistant', 'content': 'Hello!'},
                {'role': 'user', 'content': 'Check git status'},
            ],
            system_prompt='Follow PEP8.',
            cwd='/workspace/app',
        )
        self.assertNotIn('Internal API tool instructions', prompt)
        self.assertIn('Follow PEP8.', prompt)
        self.assertIn('Workspace directory: /workspace/app', prompt)
        self.assertIn('Conversation history:', prompt)
        self.assertIn('Current request:\nCheck git status', prompt)

    def test_prepare_vm_login_returns_official_cli_commands_for_docker_sandbox(self):
        self.client.force_authenticate(user=self.owner)

        # Legacy backend OAuth proxy endpoints must be removed
        self.assertEqual(
            self.client.post(
                f'/sandbox/workspaces/{self.workspace.uuid}/provider-keys/oauth/start/',
                {'provider': 'anthropic_sub'},
                format='json',
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.post(
                f'/sandbox/workspaces/{self.workspace.uuid}/provider-keys/oauth/complete/',
                {'session_id': 'x'},
                format='json',
            ).status_code,
            404,
        )

        vm_login_url = f'/sandbox/workspaces/{self.workspace.uuid}/provider-keys/vm-login/'
        fake_manager = Mock()
        fake_manager.get_or_create.return_value = Mock()
        with patch('sandbox.services.sandbox_session.get_sandbox_manager', return_value=fake_manager):
            for provider, expected_cmd in (
                ('anthropic_sub', 'claude auth login'),
                ('openai_sub', 'codex login --device-auth'),
                ('antigravity_sub', 'agy -p'),
            ):
                resp = self.client.post(vm_login_url, {'provider': provider}, format='json')
                self.assertEqual(resp.status_code, 200, resp.data)
                self.assertEqual(resp.data['provider'], provider)
                self.assertTrue(resp.data['sandbox_uuid'])
                self.assertTrue(resp.data['ready'])
                self.assertIn(expected_cmd, resp.data['login_command'])
                self.assertIn('rm -f ', resp.data['login_command'])
                self.assertTrue(resp.data['auth_paths'])

    def test_personal_byos_subscription_not_shared_with_other_workspace_members(self):
        self.client.force_authenticate(user=self.owner)
        self._connect_vm_provider('anthropic_sub')
        byos_model = Model.objects.filter(workspace=self.workspace, provider_name='anthropic_sub').first()
        self.assertIsNotNone(byos_model)

        # Owner can use their own personal BYOS subscription and sees the models
        owner_conv = Conversation.objects.create(user=self.owner, workspace=self.workspace)
        owner_msg = Message.objects.create(conversation=owner_conv, role='user', content='Hi')
        owner_req = _create_request(byos_model, owner_conv, self.owner, owner_msg, {}, stream=True)
        secret, endpoint = credentials_for_request(byos_model, owner_req)
        self.assertEqual(secret, '')
        self.assertEqual(endpoint, 'byos://anthropic_sub')

        owner_models_resp = self.client.get(f'/models/?workspace_id={self.workspace.uuid}')
        self.assertEqual(owner_models_resp.status_code, 200)
        owner_names = [m['name'] for m in owner_models_resp.data.get('results', owner_models_resp.data)]
        self.assertIn(byos_model.name, owner_names)

        # Another workspace member cannot see or execute requests against owner's personal BYOS subscription
        member_conv = Conversation.objects.create(user=self.member, workspace=self.workspace)
        member_msg = Message.objects.create(conversation=member_conv, role='user', content='Hi')
        member_req = _create_request(byos_model, member_conv, self.member, member_msg, {}, stream=True)
        with self.assertRaises(ValueError):
            credentials_for_request(byos_model, member_req)

        member_client = APIClient()
        member_client.force_authenticate(user=self.member)
        member_models_resp = member_client.get(f'/models/?workspace_id={self.workspace.uuid}')
        self.assertEqual(member_models_resp.status_code, 200)
        member_names = [m['name'] for m in member_models_resp.data.get('results', member_models_resp.data)]
        self.assertNotIn(byos_model.name, member_names)

    def test_parse_agy_models_output(self):
        from sandbox.services.byos_models import _parse_agy_models_output

        sample = (
            "\r⠋ Fetching available models...\r⠙ Fetching available models...\r"
            "gemini-4-argon-high\tGemini 4 Argon (High)\n"
            "gemini-4-hydrogen-xhigh         Gemini 4 Hydrogen (XHigh)\n"
            "gemini-pro-orchestrator-g1-pro  Orchestrator (Argon)\n"
            "claude-opus-5-5-high\tClaude Opus 5.5 (High)\n"
            "gpt-oss-120b-medium             GPT-OSS 120B (Medium)\n"
        )
        parsed = _parse_agy_models_output(sample)
        self.assertEqual(len(parsed), 5)
        self.assertEqual(parsed[0]['external_model_id'], 'gemini-4-argon-high')
        self.assertEqual(parsed[0]['display_name'], 'Gemini 4 Argon (High)')
        self.assertTrue(parsed[0]['is_reasoning'])
        self.assertEqual(parsed[2]['external_model_id'], 'gemini-pro-orchestrator-g1-pro')
        self.assertFalse(parsed[2]['is_reasoning'])
        self.assertEqual(parsed[3]['external_model_id'], 'claude-opus-5-5-high')
        self.assertEqual(parsed[4]['external_model_id'], 'gpt-oss-120b-medium')

    def test_no_default_models_created_when_live_sync_empty(self):
        with patch(
            'sandbox.services.byos_models.fetch_live_byos_models_with_status',
            return_value=([], 'No live models'),
        ):
            res = self._connect_vm_provider('antigravity_sub')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(
            Model.objects.filter(workspace=self.workspace, provider_name='antigravity_sub').count(),
            0,
        )

    def test_parse_codex_debug_models_output_and_sync_efforts(self):
        import sandbox.services.byos_models as byos_models_mod
        from sandbox.services.byos_models import (
            _fetch_codex_cli_models,
            _parse_codex_debug_models_output,
        )

        self.assertFalse(hasattr(byos_models_mod, 'requests'))

        payload = {
            'models': [
                {
                    'slug': 'gpt-6-luna',
                    'display_name': 'GPT-6-Luna',
                    'visibility': 'list',
                    'default_reasoning_level': 'medium',
                    'supported_reasoning_levels': [
                        {'effort': 'low'},
                        {'effort': 'medium'},
                        {'effort': 'high'},
                        {'effort': 'xhigh'},
                        {'effort': 'max'},
                        {'effort': 'ultra'},
                    ],
                    'context_window': 272000,
                    'input_modalities': ['text', 'image'],
                },
                {
                    'slug': 'codex-auto-review',
                    'display_name': 'Codex Auto Review',
                    'visibility': 'hide',
                    'default_reasoning_level': 'low',
                    'supported_reasoning_levels': [{'effort': 'low'}],
                    'context_window': 128000,
                    'input_modalities': ['text'],
                },
            ]
        }
        parsed = _parse_codex_debug_models_output(json.dumps(payload))
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]['external_model_id'], 'gpt-6-luna')
        self.assertEqual(parsed[0]['display_name'], 'GPT-6-Luna')
        self.assertEqual(parsed[0]['supported_efforts'], ['low', 'medium', 'high', 'xhigh', 'max'])
        self.assertEqual(parsed[0]['default_effort'], 'medium')
        self.assertEqual(parsed[0]['context_length'], 272000)
        self.assertTrue(parsed[0]['supports_vision'])

        captured_env = {}

        def fake_run(cmd, capture_output=False, text=False, env=None, timeout=None):
            captured_env['cmd'] = cmd
            proc = MagicMock()
            proc.stdout = json.dumps(payload)
            proc.stderr = ''
            return proc

        def fake_vm_exec(*args, **kwargs):
            cmd_str = ' '.join(str(a) for a in args)
            if 'codex debug models' in cmd_str:
                return _FakeVMProcess(stdout_lines=io.StringIO(json.dumps(payload)))
            return _FakeVMProcess(stdout_lines=io.StringIO(json.dumps({'present': True, 'path': '/root/.codex/auth.json'})))

        fake_runtime = Mock()
        fake_runtime.exec.side_effect = fake_vm_exec
        fake_manager = Mock()
        fake_manager.get_or_create.return_value = fake_runtime

        self._live_models_patcher.stop()
        try:
            with (
                patch('sandbox.services.byos_models._find_cli_binary', return_value='/usr/local/bin/codex'),
                patch('sandbox.services.byos_models.subprocess.run', side_effect=fake_run),
                patch('sandbox.services.sandbox_session.get_sandbox_manager', return_value=fake_manager),
            ):
                models, warning = _fetch_codex_cli_models()
                self.assertIsNone(warning)
                self.assertEqual(len(models), 1)
                self.assertEqual(captured_env['cmd'], ['/usr/local/bin/codex', 'debug', 'models'])

                res = self.client.post(self.sync_url, {'provider': 'openai_sub'})
        finally:
            self._live_models_patcher.start()

        self.assertEqual(res.status_code, 200)
        self.assertIsNone(res.data.get('sync_warning'))
        model_obj = Model.objects.get(
            workspace=self.workspace,
            provider_name='openai_sub',
            external_model_id='gpt-6-luna',
        )
        self.assertEqual(model_obj.display_name, 'GPT-6-Luna')
        self.assertEqual(model_obj.llm_config.supported_reasoning_efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
        self.assertEqual(model_obj.llm_config.default_reasoning_effort, 'medium')

@override_settings(
    CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
    SECURE_SSL_REDIRECT=False,
)
class BYOSTitleTests(TransactionTestCase):
    def test_byos_conversation_titles_with_workspace_auxiliary_model_without_vm_cli(self):
        owner = User.objects.create_user(
            username='byos-title-owner',
            email='byos-title-owner@example.com',
            password='password123',
        )
        workspace = Workspace.objects.create(
            name='BYOS Title Team',
            slug='byos-title-team',
            owner=owner,
        )
        WorkspaceMembership.objects.create(workspace=workspace, user=owner, role='owner')

        client = APIClient()
        client.force_authenticate(owner)
        fake_proc = _FakeVMProcess(stdout_lines=io.StringIO(json.dumps({'present': True, 'path': '/root/.codex/auth.json'})))
        fake_runtime = Mock()
        fake_runtime.exec.return_value = fake_proc
        fake_manager = Mock()
        fake_manager.get_or_create.return_value = fake_runtime
        with (
            patch('sandbox.services.byos_models.fetch_live_byos_models_with_status', side_effect=_fake_live_models),
            patch('sandbox.services.sandbox_session.get_sandbox_manager', return_value=fake_manager),
        ):
            res = client.post(f'/sandbox/workspaces/{workspace.pk}/provider-keys/sync-from-vm/', {'provider': 'openai_sub'})
        self.assertEqual(res.status_code, 200)

        byos_model = Model.objects.filter(workspace=workspace, provider_name='openai_sub').first()
        conversation = Conversation.objects.create(user=owner, workspace=workspace)
        user_msg = Message.objects.create(conversation=conversation, role='user', content='elon musk hakkında webde arama yap')
        req = _create_request(byos_model, conversation, owner, user_msg, {}, stream=True)

        svc = ChatService.__new__(ChatService)
        svc.conversation = conversation
        svc.current_request = req
        svc.model_tag = byos_model

        # The subscription cannot serve side calls; the workspace's own OpenRouter
        # key and auxiliary model do.
        from sandbox.tests.byok_helpers import add_workspace_key
        add_workspace_key(workspace, 'openrouter', 'sk-or-workspace-title', user=owner)
        workspace.auxiliary_model = Model.objects.create(
            name='ws-title-helper',
            model_type='text',
            author=owner,
            workspace=workspace,
            is_external=True,
            provider_name='openrouter',
            external_url='https://openrouter.ai/api/v1',
            external_model_id='google/gemini-2.5-flash-lite',
        )
        workspace.save(update_fields=['auxiliary_model'])

        with patch('chat.services.utils.OpenAI') as mock_openai, patch(
            'sandbox.services.sandbox_session.get_sandbox_manager'
        ) as mock_mgr:
            mock_openai.return_value.chat.completions.create.return_value.choices = [
                SimpleNamespace(message=SimpleNamespace(content='Elon Musk Güncel Haberler'))
            ]
            thread = svc._start_title_generation()
            self.assertIsNotNone(thread)
            thread.join(3)

        mock_mgr.assert_not_called()
        create_kwargs = mock_openai.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(create_kwargs['model'], 'google/gemini-2.5-flash-lite')
        self.assertEqual(mock_openai.call_args.kwargs['api_key'], 'sk-or-workspace-title')
        conversation.refresh_from_db()
        self.assertEqual(conversation.title, 'Elon Musk Güncel Haberler')

    def test_byos_desktop_mcp_server_and_event_normalization(self):
        from sandbox.services import byos_mcp_server

        init_resp = byos_mcp_server.handle_jsonrpc_message({
            'jsonrpc': '2.0',
            'id': 1,
            'method': 'initialize',
            'params': {'protocolVersion': '2024-11-05'},
        })
        self.assertEqual(init_resp['result']['serverInfo']['name'], 'neuronrunner-desktop')

        list_resp = byos_mcp_server.handle_jsonrpc_message({
            'jsonrpc': '2.0',
            'id': 2,
            'method': 'tools/list',
        })
        tools = list_resp['result']['tools']
        self.assertEqual([t['name'] for t in tools], ['desktop'])

        fake_file_tools = SimpleNamespace(
            desktop_control=Mock(return_value={
                'status': 'ok',
                'action': 'screenshot',
                'width': 1280,
                'height': 720,
                'path': '/workspace/.neuronrunner/desktop-latest.png',
                'image_url': 'data:image/png;base64,ZmFrZV9wbmc=',
                'message': 'Desktop screenshot captured.',
            })
        )
        with patch.object(byos_mcp_server, '_load_file_tools', return_value=fake_file_tools):
            call_resp = byos_mcp_server.handle_jsonrpc_message({
                'jsonrpc': '2.0',
                'id': 3,
                'method': 'tools/call',
                'params': {'name': 'desktop', 'arguments': {'action': 'screenshot'}},
            })
        self.assertFalse(call_resp['result']['isError'])
        content = call_resp['result']['content']
        self.assertEqual(content[0]['type'], 'text')
        meta = json.loads(content[0]['text'])
        self.assertEqual(meta['status'], 'ok')
        self.assertNotIn('image_url', meta)
        self.assertEqual(content[1], {'type': 'image', 'data': 'ZmFrZV9wbmc=', 'mimeType': 'image/png'})

        claude_evts = normalize_byos_line(
            'anthropic_sub',
            json.dumps({
                'type': 'assistant',
                'message': {
                    'content': [{
                        'type': 'tool_use',
                        'id': 'tc_desk_1',
                        'name': 'mcp__neuronrunner__desktop',
                        'input': {'action': 'screenshot'},
                    }],
                },
            }),
        )
        self.assertEqual(claude_evts[0]['name'], 'desktop')
        self.assertEqual(claude_evts[0]['title'], 'Desktop')

        codex_evts = normalize_byos_line(
            'openai_sub',
            json.dumps({
                'type': 'item.completed',
                'item': {
                    'id': 'item_desk_1',
                    'type': 'mcp_tool_call',
                    'server': 'neuronrunner',
                    'tool': 'desktop',
                    'arguments': {'action': 'screenshot'},
                    'result': {'status': 'ok'},
                },
            }),
        )
        self.assertEqual(codex_evts[0]['name'], 'desktop')
        self.assertEqual(codex_evts[1]['name'], 'desktop')

        agy_evts = normalize_byos_line(
            'antigravity_sub',
            json.dumps({
                'event': 'step_update',
                'step_update': {
                    'step_index': 2,
                    'step_type': 'tool',
                    'state': 'DONE',
                    'tool_name': 'neuronrunner_desktop',
                    'tool_id': 'agy_desk_1',
                    'tool_info': {
                        'name': 'neuronrunner_desktop',
                        'parameters': {'action': 'screenshot'},
                        'output': 'ok',
                    },
                },
            }),
        )
        self.assertEqual(agy_evts[0]['name'], 'desktop')
        self.assertEqual(agy_evts[0]['title'], 'Desktop')
        self.assertEqual(agy_evts[1]['name'], 'desktop')

        prompt = build_byos_prompt(
            [{'role': 'user', 'content': 'Open desktop'}],
            cwd='/workspace/app',
            has_desktop_mcp=True,
        )
        self.assertIn('`desktop` tool (via MCP)', prompt)

    def test_antigravity_edit_file_synthesizes_diff_output(self):
        from chat.services.byos_runner import normalize_byos_line

        evts = normalize_byos_line(
            'antigravity_sub',
            json.dumps({
                'event': 'step_update',
                'step_update': {
                    'step_index': 3,
                    'step_type': 'tool',
                    'state': 'DONE',
                    'tool_name': 'edit_file',
                    'tool_id': 'agy_edit_1',
                    'tool_info': {
                        'name': 'edit_file',
                        'parameters': {
                            'Path': '/workspace/app/foo.py',
                            'Target': 'x = 1\n',
                            'Replacement': 'x = 2\n',
                        },
                        'output': '',
                    },
                },
            }),
        )
        self.assertEqual(len(evts), 2)
        self.assertEqual(evts[1]['kind'], 'tool_result')
        output = evts[1]['result']['output']
        self.assertIn('--- a//workspace/app/foo.py', output)
        self.assertIn('-x = 1', output)
        self.assertIn('+x = 2', output)


class ClaudeCliModelParsingTests(TestCase):
    """Shape mirrors the real `claude` CLI initialize control_response (v2.1.x)."""

    def _raw(self):
        efforts = ['low', 'medium', 'high', 'xhigh', 'max']
        models = [
            {'value': 'default', 'resolvedModel': 'claude-opus-5-5', 'displayName': 'Default (recommended)',
             'supportsEffort': True, 'supportedEffortLevels': efforts},
            {'value': 'opus', 'resolvedModel': 'claude-opus-5-5', 'displayName': 'Opus 5.5',
             'supportsEffort': True, 'supportedEffortLevels': efforts},
            {'value': 'haiku', 'resolvedModel': 'claude-haiku-4-5-20251001', 'displayName': 'Haiku 4.5',
             'supportsThinkingOff': True},
            {'value': 'claude-opus-4-6', 'resolvedModel': 'claude-opus-4-6', 'displayName': 'Opus 4.6',
             'supportsEffort': True, 'supportedEffortLevels': ['low', 'medium', 'high', 'max']},
        ]
        payload = {'type': 'control_response', 'response': {'subtype': 'success', 'response': {'models': models}}}
        return '{"type":"system","subtype":"init"}\n' + json.dumps(payload) + '\n'

    def test_exposes_only_moving_aliases_with_cli_efforts(self):
        from sandbox.services.byos_models import _parse_claude_initialize_output

        models = _parse_claude_initialize_output(self._raw())
        self.assertEqual([m['external_model_id'] for m in models], ['opus', 'haiku'])
        self.assertEqual(models[0]['display_name'], 'Claude Opus 5.5')
        self.assertEqual(models[0]['supported_efforts'], ['low', 'medium', 'high', 'xhigh', 'max'])
        self.assertTrue(models[0]['is_reasoning'])
        self.assertFalse(models[1]['is_reasoning'])

    def test_garbage_returns_empty(self):
        from sandbox.services.byos_models import _parse_claude_initialize_output

        self.assertEqual(_parse_claude_initialize_output('not json\n{bad'), [])

    def test_no_static_fallback_when_cli_unavailable(self):
        from sandbox.services.byos_models import fetch_live_byos_models_with_status

        models, warning = fetch_live_byos_models_with_status('anthropic_sub', runtime=None)
        self.assertEqual(models, [])
        self.assertTrue(warning)

