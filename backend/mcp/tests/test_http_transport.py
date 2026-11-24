"""Exercise the installed SDK against a real HTTP MCP endpoint (no transport mocks)."""
import asyncio
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import httpx
from django.test import SimpleTestCase, override_settings

from mcp.errors import connection_error_message
from mcp.services import _run_async, discover_tools, execute_tool


class MCPHandler(BaseHTTPRequestHandler):
    expected_token = 'Bearer transport-test-token'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(405)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        if self.headers.get('Authorization') != self.expected_token:
            self.send_response(401)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'id' not in request:
            self.send_response(202)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        method = request['method']
        if method == 'initialize':
            result = {'protocolVersion': '2025-11-25', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'transport-fixture', 'version': '1.0'}}
        elif method == 'tools/list':
            result = {'tools': [{'name': 'example', 'description': 'Example tool', 'inputSchema': {'type': 'object', 'properties': {}}}]}
        elif method == 'tools/call':
            result = {'content': [{'type': 'text', 'text': 'example answer'}], 'isError': False}
        else:
            raise AssertionError(f'Unexpected MCP method: {method}')
        payload = json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


@override_settings(MCP_URL_VALIDATION_ENABLED=False)
class InstalledSDKHTTPTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), MCPHandler)
        cls.thread = threading.Thread(target=lambda: cls.server.serve_forever(poll_interval=0.01), daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/mcp'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        super().tearDownClass()

    def test_real_sdk_initializes_and_discovers_tools(self):
        tools = discover_tools(None, self.url, 'http', http_transport='streamable-http',
                               headers_json={'Authorization': 'Bearer transport-test-token'})
        self.assertEqual(tools, [{'name': 'example', 'description': 'Example tool', 'input_schema': {'type': 'object', 'properties': {}}}])

    def test_real_sdk_executes_a_tool(self):
        result, _ = execute_tool('http', None, self.url, None, 'example', {},
            http_transport='streamable-http', headers_json={'Authorization': 'Bearer transport-test-token'})
        self.assertEqual(result, 'example answer')

    def test_auth_rejection_preserves_http_cause_instead_of_taskgroup_wrapper(self):
        with self.assertRaises(Exception) as captured:
            discover_tools(None, self.url, 'http', http_transport='streamable-http')
        self.assertNotIsInstance(captured.exception, BaseExceptionGroup)
        self.assertIn('HTTP 401', connection_error_message(captured.exception))
        self.assertNotIn('TaskGroup', connection_error_message(captured.exception))


class TransportErrorTests(SimpleTestCase):
    def test_single_nested_taskgroup_raises_original_cause(self):
        original = ValueError('inner transport failure')
        async def fail():
            raise ExceptionGroup('outer', [ExceptionGroup('inner', [original])])
        with self.assertRaises(ValueError) as captured:
            _run_async(fail())
        self.assertIs(captured.exception, original)

    def test_grouped_http_errors_do_not_expose_urls_or_response_bodies(self):
        request = httpx.Request('POST', 'https://example.com/mcp?api_key=private-token')
        response = httpx.Response(403, request=request, text='private-provider-response')
        error = httpx.HTTPStatusError('private-provider-response with private-token', request=request, response=response)
        message = connection_error_message(ExceptionGroup('unhandled errors in a TaskGroup', [error, RuntimeError('cleanup')]))
        self.assertIn('HTTP 403', message)
        self.assertNotIn('private-', message)
        self.assertNotIn('TaskGroup', message)

    def test_grouped_timeout_has_actionable_message(self):
        self.assertEqual(connection_error_message(ExceptionGroup('TaskGroup', [TimeoutError()])),
                         'MCP connection timed out. Check the server and try again.')
