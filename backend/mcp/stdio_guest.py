"""Dependency-free MCP stdio client. Executed ONLY inside the workspace sandbox.

The backend sends data as a separate argv entry, never as Python/shell source.
No backend environment or credentials are copied into the guest.
"""
import json
import os
import shlex
import signal
import subprocess
import sys
import threading

MAX_MESSAGE = 4 * 1024 * 1024


def run(request):
    command = shlex.split(request['command'])
    if not command:
        raise ValueError('An MCP server command is required.')
    # Only workspace defaults and this connector's explicit secrets reach MCP.
    env = {
        'PATH': '/usr/local/bin:/usr/bin:/bin:/root/.local/bin',
        'HOME': '/root', 'LANG': 'C.UTF-8', 'TMPDIR': '/tmp',
        'WORKSPACE_ROOT': '/workspace',
        **{key: str(value) for key, value in request.get('env', {}).items()},
    }
    if os.path.basename(command[0]) in ('npx', 'npm'):
        # npm otherwise suppresses failing postinstall output for npx packages.
        env.setdefault('npm_config_foreground_scripts', 'true')
        npx_cache = os.path.join(env.get('HOME', '/root'), '.npm', '_npx')
        if os.path.isdir(npx_cache):
            for entry in os.listdir(npx_cache):
                full = os.path.join(npx_cache, entry)
                if os.path.isdir(full) and not (os.path.isfile(os.path.join(full, 'package.json')) and os.path.isdir(os.path.join(full, 'node_modules'))):
                    import shutil
                    shutil.rmtree(full, ignore_errors=True)
    process = None
    stderr_tail = bytearray()
    startup_output = bytearray()
    stderr_reader = None
    failure = None
    phase = 'startup and initialization'
    startup_timeout = float(request.get('startup_timeout', request['timeout']))

    def expired(signum, frame):
        raise TimeoutError(f'MCP {phase} timed out inside the workspace sandbox.')

    previous_handler = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.01, startup_timeout))
    try:
        if request.get('tool_name') is not None and 'prepare_playwright' in globals():
            phase = 'browser setup'
            prepare_playwright(command, env)
            phase = 'startup and initialization'
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, cwd='/workspace', env=env,
            start_new_session=True,
        )

        def drain_stderr():
            while True:
                chunk = os.read(process.stderr.fileno(), 4096)
                if not chunk:
                    return
                stderr_tail.extend(chunk)
                del stderr_tail[:-8192]

        stderr_reader = threading.Thread(target=drain_stderr, daemon=True)
        stderr_reader.start()

        def send(message):
            process.stdin.write((json.dumps({'jsonrpc': '2.0', **message}) + '\n').encode())
            process.stdin.flush()

        next_id = 0

        def rpc(method, params):
            nonlocal next_id
            next_id += 1
            request_id = next_id
            send({'id': request_id, 'method': method, 'params': params})
            while True:
                line = process.stdout.readline(MAX_MESSAGE + 1)
                if not line:
                    try:
                        exit_code = process.wait(timeout=0.2)
                    except subprocess.TimeoutExpired:
                        exit_code = None
                    detail = f'exit code {exit_code}; {phase}' if exit_code is not None else phase
                    raise RuntimeError(f'MCP server exited before responding ({detail}).')
                if len(line) > MAX_MESSAGE:
                    raise RuntimeError('MCP server response exceeded 4 MiB.')
                try:
                    message = json.loads(line)
                    if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
                        raise ValueError('Not a protocol message')
                except (ValueError, UnicodeError):
                    if phase != 'startup and initialization':
                        raise RuntimeError('MCP server wrote invalid JSON instead of a protocol response.') from None
                    # Foreground package setup may print progress before the MCP
                    # executable starts. Keep bounded diagnostics, then wait for RPC.
                    startup_output.extend(line)
                    del startup_output[:-8192]
                    continue
                if 'method' in message:
                    if 'id' in message:
                        # No host filesystem roots or server-initiated sampling.
                        if message['method'] == 'ping':
                            reply = {'result': {}}
                        elif message['method'] == 'roots/list':
                            reply = {'result': {'roots': []}}
                        else:
                            reply = {'error': {'code': -32601, 'message': 'Method not supported'}}
                        send({'id': message['id'], **reply})
                    continue
                if message.get('id') == request_id:
                    if 'error' in message:
                        raise RuntimeError('MCP server rejected the request: ' + str(message['error'].get('message', 'Unknown error')))
                    return message['result']

        rpc('initialize', {
            'protocolVersion': '2024-11-05', 'capabilities': {},
            'clientInfo': {'name': 'neuronrunner-sandbox', 'version': '1.0'},
        })
        send({'method': 'notifications/initialized'})
        # Package download/install and handshake have a separate startup budget.
        # The configured tool timeout begins only after the server is ready.
        phase = 'tool discovery' if request.get('tool_name') is None else 'tool execution'
        signal.setitimer(signal.ITIMER_REAL, max(0.01, float(request['timeout'])))
        if request.get('tool_name') is None:
            tools = []
            params = {}
            for _ in range(100):
                result = rpc('tools/list', params)
                tools.extend({
                    'name': tool['name'], 'description': tool.get('description') or '',
                    'input_schema': tool.get('inputSchema') or {},
                } for tool in result.get('tools', []))
                if len(json.dumps(tools).encode()) > MAX_MESSAGE:
                    raise RuntimeError('MCP tool catalog exceeded 4 MiB.')
                cursor = result.get('nextCursor')
                if not cursor:
                    return tools
                params = {'cursor': cursor}
            raise RuntimeError('MCP server returned too many tool catalog pages.')
        result = rpc('tools/call', {'name': request['tool_name'], 'arguments': request.get('arguments', {})})
        texts = [str(item.get('text', item.get('data', item))) for item in result.get('content', [])]
        text = '\n'.join(texts) if texts else json.dumps(result)
        if result.get('isError'):
            raise RuntimeError('MCP tool execution failed: ' + text)
        return text
    except Exception as exc:
        failure = exc
        raise
    finally:
        # Descendants of package launchers must stop on success and timeout.
        signal.setitimer(signal.ITIMER_REAL, 0)
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        if stderr_reader is not None:
            stderr_reader.join(timeout=1)
        if failure is not None:
            detail = (startup_output + b'\n' + stderr_tail).decode('utf-8', errors='replace').strip()
            message = str(failure) + ('\nServer output: ' + detail[-4096:] if detail else '')
            # Error responses belong to the caller, but connector secrets must
            # still never appear in diagnostics, even if a package echoes them.
            for value in request.get('env', {}).values():
                if len(str(value)) >= 4:
                    message = message.replace(str(value), '[REDACTED]')
            failure.args = (message,)
        signal.signal(signal.SIGALRM, previous_handler)


def main():
    try:
        response = {'result': run(json.loads(sys.argv[1]))}
    except TimeoutError as exc:
        response = {'error': str(exc), 'timeout': True}
    except Exception as exc:
        detail = str(exc)
        response = {'error': detail if detail.startswith('MCP ') else 'MCP workspace server failed: ' + detail}
    print(json.dumps(response), flush=True)


if __name__ == '__main__':
    main()
