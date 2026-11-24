import io
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.test import APIClient

from chat.models import Conversation
from chat.services.chat_service import ChatService
from sandbox.models import WorkspaceMembership
from sandbox.services.sandbox_service import SandboxBootstrapService
from mcp.models import MCPServer, MCPServerTool
from mcp.sandbox_transport import run_stdio
from mcp.services import discover_tools, execute_tool


@override_settings(
    SECURE_SSL_REDIRECT=False,
    CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
    REMOTE_ONLY_MCP=False,
    MCP_URL_VALIDATION_ENABLED=False,
)
class LocalMCPSandboxTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='local-mcp-user', email='local-mcp@example.com')
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.other = get_user_model().objects.create_user(username='other-mcp-user', email='other-mcp@example.com')
        self.other_workspace = SandboxBootstrapService.ensure_personal_workspace(self.other)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.server = MCPServer.objects.create(
            user=self.user, workspace=self.workspace, name='local',
            command='npx -y example', transport='stdio', enabled=True,
        )
        MCPServerTool.objects.create(server=self.server, name='echo', input_schema={'type': 'object'})

    def payload(self, **extra):
        return {'name': 'new-local', 'transport': 'stdio', 'command': 'npx -y example',
                'workspace': str(self.workspace.pk), **extra}

    def service(self, workspace=None):
        conversation = Conversation.objects.create(user=self.user, workspace=workspace or self.workspace)
        # MCP methods don't require model/API initialization.
        service = ChatService.__new__(ChatService)
        service.conversation = conversation
        service.current_request = SimpleNamespace(user=self.user)
        return service

    def test_api_rejects_missing_or_foreign_workspace_before_discovery(self):
        with patch('mcp.services.discover_tools') as discover:
            for workspace, code in [(None, 400), (str(self.other_workspace.pk), 403)]:
                response = self.client.post('/mcp/', self.payload(workspace=workspace), format='json')
                self.assertEqual(response.status_code, code, response.data)
            discover.assert_not_called()

    def test_api_create_test_refresh_execute_all_pass_actor_and_workspace(self):
        tools = [{'name': 'echo', 'description': '', 'input_schema': {}}]
        with patch('mcp.services.discover_tools', return_value=tools) as create:
            response = self.client.post('/mcp/', self.payload(), format='json')
        self.assertEqual(response.status_code, 201, response.data)
        with patch('mcp.views.discover_tools', return_value=tools) as test:
            self.assertEqual(self.client.post(f'/mcp/{self.server.pk}/test/').status_code, 200)
        with patch('mcp.services.discover_tools', return_value=tools) as refresh:
            self.assertEqual(self.client.post(f'/mcp/{self.server.pk}/refresh/').status_code, 200)
        with patch('mcp.views.execute_tool', return_value=('done', 5)) as execute:
            response = self.client.post('/mcp/execute/', {'tool_name': 'mcp__local__echo', 'arguments': {}}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        for call in (create, test, refresh, execute):
            self.assertEqual(call.call_args.kwargs['user_uuid'], str(self.user.pk))
            self.assertEqual(call.call_args.kwargs['workspace_uuid'], str(self.workspace.pk))

    def test_runtime_exec_receives_data_without_backend_environment(self):
        runtime = Mock()
        runtime.exec.return_value = SimpleNamespace(stdout=io.BytesIO(b'{"result": []}'), wait=lambda timeout: 0)
        command = "python3 -c 'print(\"$(touch /tmp/never)\")'"
        with patch.dict(os.environ, {'BACKEND_ONLY_SECRET': 'never-copy-me'}), patch('sandbox.services.sandbox_session.get_sandbox_manager') as manager:
            manager.return_value.get_or_create.return_value = runtime
            self.assertEqual(discover_tools(command, None, 'stdio', {'MCP_KEY': 'explicit'},
                user_uuid=str(self.user.pk), workspace_uuid=str(self.workspace.pk)), [])
        args, kwargs = runtime.exec.call_args
        self.assertEqual(args[:4], ('python3', '-I', '-u', '-c'))
        request = json.loads(args[5])
        self.assertEqual(request['command'], command)
        self.assertEqual(request['env'], {'MCP_KEY': 'explicit'})
        self.assertGreaterEqual(request['startup_timeout'], 120)
        self.assertEqual(kwargs['timeout'], request['startup_timeout'] + request['timeout'] + 5)
        self.assertNotIn('never-copy-me', repr(runtime.exec.call_args))
        self.assertNotIn('env', kwargs)
        self.assertEqual(manager.return_value.get_or_create.call_args.args[0].workspace_id, self.workspace.pk)

    def test_saving_inactive_local_configuration_does_not_start_the_package_twice(self):
        with patch('mcp.services.discover_tools') as discover:
            response = self.client.post('/mcp/', self.payload(enabled=False), format='json')
            self.assertEqual(response.status_code, 201, response.data)
            response = self.client.patch(f"/mcp/{response.data['uuid']}/", self.payload(enabled=False), format='json')
            self.assertEqual(response.status_code, 200, response.data)
            discover.assert_not_called()

    def test_api_preserves_timeout_phase_and_redacted_package_diagnostics(self):
        message = 'MCP startup and initialization timed out. Server output: downloading packages'
        with patch('mcp.views.discover_tools', side_effect=TimeoutError(message)):
            response = self.client.post(f'/mcp/{self.server.pk}/test/')
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.data['error'], message)

    def test_missing_context_and_revoked_membership_never_start_a_runtime(self):
        with patch('sandbox.services.sandbox_session.get_sandbox_manager') as manager:
            with self.assertRaises(ValidationError):
                discover_tools('python3', None, 'stdio')
            WorkspaceMembership.objects.filter(workspace=self.workspace, user=self.user).delete()
            for operation in (
                lambda: discover_tools('python3', None, 'stdio', user_uuid=self.user.pk, workspace_uuid=self.workspace.pk),
                lambda: execute_tool('stdio', 'python3', None, {}, 'echo', {}, user_uuid=self.user.pk, workspace_uuid=self.workspace.pk),
            ):
                with self.assertRaises(PermissionDenied):
                    operation()
            manager.assert_not_called()
        for suffix in ('test/', 'refresh/'):
            response = self.client.post(f'/mcp/{self.server.pk}/{suffix}')
            self.assertIn(response.status_code, (400, 403))

    def test_runtime_failure_cannot_fall_back_to_host_subprocess(self):
        with patch('sandbox.services.sandbox_session.get_sandbox_manager') as manager, patch('subprocess.Popen') as popen:
            manager.return_value.get_or_create.side_effect = RuntimeError('Sandbox unavailable')
            with self.assertRaisesRegex(RuntimeError, 'Sandbox unavailable'):
                run_stdio('python3', {}, user_uuid=self.user.pk, workspace_uuid=self.workspace.pk, timeout=1)
            popen.assert_not_called()

    def test_legacy_unbound_connector_is_rejected_and_not_advertised(self):
        self.server.workspace = None
        self.server.save()
        self.assertEqual(self.client.patch(f'/mcp/{self.server.pk}/', {'enabled': True}, format='json').status_code, 400)
        self.assertEqual(self.client.post(f'/mcp/{self.server.pk}/test/').status_code, 400)
        self.assertEqual(self.client.get('/mcp/tools/').data, [])
        self.assertEqual(self.service()._get_mcp_tools(), [])

    def test_chat_scopes_local_tools_to_conversation_workspace(self):
        service = self.service(self.other_workspace)
        with patch('mcp.services.execute_tool') as execute:
            self.assertEqual(service._get_mcp_tools(), [])
            self.assertIn('error', service.execute_mcp_tool('mcp__local__echo', {}))
            execute.assert_not_called()
        service = self.service()
        self.assertEqual(len(service._get_mcp_tools()), 1)
        with patch('mcp.services.execute_tool', return_value=('done', 5)) as execute:
            self.assertEqual(service.execute_mcp_tool('mcp__local__echo', {}), {'result': 'done'})
        self.assertEqual(execute.call_args.kwargs['user_uuid'], str(self.user.pk))
        self.assertEqual(execute.call_args.kwargs['workspace_uuid'], str(self.workspace.pk))


class GuestProtocolTests(SimpleTestCase):
    # Exercise a real stdio subprocess using a temporary fake MCP server. This
    # is a protocol test harness, never the production backend transport.
    SERVER = '''
import json, os, sys, time
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    if 'id' not in request:
        continue
    if method == 'initialize':
        result = {'protocolVersion': '2024-11-05', 'capabilities': {}, 'serverInfo': {'name': 'test', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'second' if request['params'].get('cursor') else 'echo', 'inputSchema': {'type': 'object'}}]}
        if not request['params'].get('cursor'):
            result['nextCursor'] = 'page-2'
    elif method == 'tools/call':
        if request['params']['name'] == 'hang':
            time.sleep(30)
        result = {'content': [{'type': 'text', 'text': json.dumps({'args': request['params']['arguments'], 'secret': os.getenv('BACKEND_ONLY_SECRET'), 'key': os.getenv('MCP_KEY')})}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
'''

    def guest(self, tool_name=None, timeout=2, server_source=None, startup_timeout=None, executable_name=None):
        # Replace only the hardcoded guest cwd for the host-side test harness.
        source = (Path(__file__).resolve().parent.parent / 'stdio_guest.py').read_text()
        with TemporaryDirectory() as directory:
            server = Path(directory, executable_name or 'server.py')
            body = server_source or self.SERVER
            server.write_text(('#!' + sys.executable + '\n' if executable_name else '') + body)
            if executable_name:
                server.chmod(0o755)
            source = source.replace("cwd='/workspace'", 'cwd=' + repr(directory))
            request = {'command': shlex.join([str(server)] if executable_name else [sys.executable, str(server)]),
                       'env': {'MCP_KEY': 'explicit'}, 'timeout': timeout,
                       'tool_name': tool_name, 'arguments': {'text': "'; $(touch never); '"}}
            if startup_timeout is not None:
                request['startup_timeout'] = startup_timeout
            result = subprocess.run([sys.executable, '-I', '-c', source, json.dumps(request)],
                env={**os.environ, 'BACKEND_ONLY_SECRET': 'must-not-inherit'},
                capture_output=True, text=True, timeout=5, check=True)
            return json.loads(result.stdout)

    def test_discovery_initializes_and_follows_pagination(self):
        result = self.guest()['result']
        self.assertEqual([tool['name'] for tool in result], ['echo', 'second'])

    def test_tool_call_preserves_arguments_and_strips_parent_secrets(self):
        result = json.loads(self.guest('echo')['result'])
        self.assertEqual(result['args'], {'text': "'; $(touch never); '"})
        self.assertIsNone(result['secret'])
        self.assertEqual(result['key'], 'explicit')

    def test_timeout_returns_structured_error(self):
        response = self.guest('hang', timeout=0.2)
        self.assertTrue(response['timeout'])
        self.assertIn('tool execution', response['error'])

    def test_cold_start_gets_a_separate_budget_from_tool_execution(self):
        source = 'import time; time.sleep(0.3)\n' + self.SERVER
        response = self.guest('echo', timeout=0.1, startup_timeout=2, server_source=source)
        self.assertIn('result', response, response)

    def test_failed_startup_includes_bounded_stderr_without_connector_secrets(self):
        source = "import sys; sys.stderr.write('x' * 20000 + '\\nmissing dependency explicit'); sys.exit(1)"
        response = self.guest(server_source=source)
        self.assertIn('missing dependency [REDACTED]', response['error'])
        self.assertLess(len(response['error']), 4500)

    def test_install_progress_on_stdout_does_not_break_initialization(self):
        source = "print('installing package...', flush=True)\n" + self.SERVER
        response = self.guest(server_source=source)
        self.assertEqual([tool['name'] for tool in response['result']], ['echo', 'second'])

    def test_failed_installer_reports_stdout_and_exit_code_without_secrets(self):
        source = "import sys; print('x' * 20000 + '\\narchive size limit exceeded explicit', flush=True); sys.exit(7)"
        response = self.guest(server_source=source)
        self.assertIn('exit code 7', response['error'])
        self.assertIn('archive size limit exceeded [REDACTED]', response['error'])
        self.assertLess(len(response['error']), 4500)

    def test_browser_failures_report_the_actual_cause_without_connector_secrets(self):
        source = self.SERVER.replace("if request['params']['name'] == 'hang':", "if request['params']['name'] == 'missing_browser':\n            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'isError':True,'content':[{'type':'text','text':'Chromium is not installed: explicit'}]}}), flush=True)\n            continue\n        if request['params']['name'] == 'hang':")
        response = self.guest('missing_browser', server_source=source)
        self.assertIn('MCP tool execution failed: Chromium is not installed: [REDACTED]', response['error'])
        self.assertNotIn('explicit', response['error'])

    def test_npx_enables_foreground_installer_diagnostics(self):
        source = self.SERVER.replace("'key': os.getenv('MCP_KEY')", "'key': os.getenv('MCP_KEY'), 'foreground': os.getenv('npm_config_foreground_scripts')")
        response = self.guest('echo', server_source=source, executable_name='npx')
        self.assertEqual(json.loads(response['result'])['foreground'], 'true')

    def test_startup_timeout_reports_its_phase_and_package_output(self):
        source = "import sys,time; print('installing dependencies', file=sys.stderr, flush=True); time.sleep(30)"
        response = self.guest(timeout=1, startup_timeout=0.2, server_source=source)
        self.assertTrue(response['timeout'])
        self.assertIn('startup and initialization', response['error'])
        self.assertIn('installing dependencies', response['error'])

    def test_real_mcp_sdk_server_discovery_and_execution(self):
        source = '''
try:
    from mcp.server.mcpserver import MCPServer as Server
except ImportError:
    from mcp.server.fastmcp import FastMCP as Server
server = Server('sandbox-protocol-test')
@server.tool()
def echo(text: str) -> str:
    return text
server.run(transport='stdio')
'''
        tools = self.guest(timeout=4, server_source=source)['result']
        self.assertEqual([tool['name'] for tool in tools], ['echo'])
        self.assertEqual(self.guest('echo', timeout=4, server_source=source)['result'], "'; $(touch never); '")
