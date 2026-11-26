"""Execute BYOS subscription CLIs inside the workspace container without storing or injecting OAuth tokens."""
from __future__ import annotations

import base64
from contextlib import suppress
import difflib
import json
import logging
from pathlib import Path
from queue import Empty, Queue
from threading import Thread
import time

from mcp.catalog import format_tool_name
from sandbox.services.provider_keys import BYOS_PROVIDERS, credentials_for_request

from .utils import sse_event

logger = logging.getLogger(__name__)

_GUEST_BYOS_RUNNER = """
import base64, json, os, re, shutil, subprocess, sys
from pathlib import Path

raw_arg = sys.argv[1]
if raw_arg.startswith('file:'):
    p = Path(raw_arg[5:])
    payload = json.loads(p.read_text(encoding='utf-8'))
    try:
        p.unlink()
    except OSError:
        pass
else:
    payload = json.loads(base64.b64decode(raw_arg).decode('utf-8'))

provider = payload['provider']
model_id = payload['model_id']
prompt = payload['prompt']
reasoning_effort = str(payload.get('reasoning_effort') or '').strip().lower()
cwd = payload.get('cwd') or '/workspace'
Path(cwd).mkdir(parents=True, exist_ok=True)
env = os.environ.copy()
env['PATH'] = '/root/.local/bin:/usr/local/bin:/usr/bin:/bin:/root/.npm-global/bin:' + env.get('PATH', '')
env['DISPLAY'] = ':1'
env['WORKSPACE_ROOT'] = cwd
# The VM is an isolated sandbox that runs as root; Claude Code refuses
# --dangerously-skip-permissions under root unless IS_SANDBOX is set.
env['IS_SANDBOX'] = '1'
mcp_server_path = '/var/lib/neuronrunner/byos_mcp_server.py'
has_mcp = Path(mcp_server_path).is_file()
temp_mcp_cfg_path = None

def ensure_cli(binary, pkg):
    found = shutil.which(binary, path=env['PATH'])
    marker = Path(f'/tmp/.nr-cli-updated-{binary}')
    if found and marker.exists():
        return found
    res = subprocess.run(['npm', 'install', '-g', f'{pkg}@latest'], capture_output=True, text=True, env=env)
    if res.returncode == 0:
        try:
            marker.write_text('ok', encoding='utf-8')
        except OSError:
            pass
        found = shutil.which(binary, path=env['PATH']) or found
        if found:
            return found
    elif found:
        return found
    if res.returncode != 0:
        sys.stderr.write((res.stderr or res.stdout or f'Failed to install {pkg}') + '\\n')
        sys.exit(res.returncode or 1)
    found = shutil.which(binary, path=env['PATH'])
    if not found:
        sys.stderr.write(f'{binary} binary not found after installing {pkg}\\n')
        sys.exit(1)
    return found

def has_any_file(paths):
    for p in paths:
        try:
            path = Path(p)
            if path.is_file() and path.stat().st_size > 0:
                return path
        except OSError:
            continue
    return None

if provider == 'anthropic_sub':
    cli = ensure_cli('claude', '@anthropic-ai/claude-code')
    if not (
        has_any_file([
            '/root/.claude/.credentials.json',
            '/home/user/.claude/.credentials.json',
            str(Path.home() / '.claude' / '.credentials.json'),
        ])
        or env.get('CLAUDE_CODE_OAUTH_TOKEN')
        or env.get('ANTHROPIC_API_KEY')
    ):
        sys.stderr.write("Claude Code credentials not found in this VM. Click 'Connect in VM' to sign in.\\n")
        sys.exit(1)
    cmd = [
        cli, '-p', prompt,
        '--model', model_id,
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
    ]
    if has_mcp:
        temp_mcp_cfg_path = f'/tmp/nr-byos-mcp-{os.getpid()}.json'
        Path(temp_mcp_cfg_path).write_text(
            json.dumps({
                'mcpServers': {
                    'neuronrunner': {
                        'command': 'python3',
                        'args': [mcp_server_path],
                        'env': {'WORKSPACE_ROOT': cwd, 'DISPLAY': ':1'},
                    }
                }
            }),
            encoding='utf-8',
        )
        cmd.extend(['--mcp-config', temp_mcp_cfg_path])
elif provider == 'openai_sub':
    cli = ensure_cli('codex', '@openai/codex')
    if not (
        has_any_file([
            '/root/.codex/auth.json',
            '/home/user/.codex/auth.json',
            str(Path.home() / '.codex' / 'auth.json'),
        ])
        or env.get('OPENAI_API_KEY')
    ):
        sys.stderr.write("OpenAI Codex credentials not found in this VM. Click 'Connect in VM' to sign in.\\n")
        sys.exit(1)
    cmd = [
        cli, 'exec', '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '-m', model_id,
    ]
    if has_mcp:
        cmd.extend([
            '-c', 'mcp_servers.neuronrunner.command="python3"',
            '-c', f'mcp_servers.neuronrunner.args={json.dumps([mcp_server_path])}',
            '-c', f'mcp_servers.neuronrunner.env.WORKSPACE_ROOT={json.dumps(cwd)}',
            '-c', 'mcp_servers.neuronrunner.env.DISPLAY=":1"',
        ])
    if reasoning_effort and reasoning_effort != 'none' and re.fullmatch(r'[a-z]+', reasoning_effort):
        cmd.extend(['-c', f'model_reasoning_effort={reasoning_effort}'])
    cmd.append(prompt)
elif provider == 'antigravity_sub':
    agy_bin = shutil.which('agy', path=env['PATH'])
    if not agy_bin and any(tok in model_id for tok in ('argon', 'hydrogen', 'orchestrator', 'claude', 'gpt-oss', '3.8')):
        subprocess.run(
            ['bash', '-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
            capture_output=True,
            text=True,
            env=env,
        )
        agy_bin = shutil.which('agy', path=env['PATH'])

    gemini_dir = Path('/root/.gemini')
    gemini_dir.mkdir(parents=True, exist_ok=True)
    trusted_file = gemini_dir / 'trustedFolders.json'
    try:
        trusted_data = json.loads(trusted_file.read_text(encoding='utf-8')) if trusted_file.is_file() else {}
    except Exception:
        trusted_data = {}
    if not isinstance(trusted_data, dict):
        trusted_data = {}
    trusted_data[cwd] = 'TRUST_FOLDER'
    trusted_data['/workspace'] = 'TRUST_FOLDER'
    trusted_file.write_text(json.dumps(trusted_data, indent=2), encoding='utf-8')

    has_agy_tok = has_any_file([
        '/root/.gemini/antigravity-cli/antigravity-oauth-token',
        '/home/user/.gemini/antigravity-cli/antigravity-oauth-token',
        str(Path.home() / '.gemini' / 'antigravity-cli' / 'antigravity-oauth-token'),
    ])
    has_oauth_creds = has_any_file([
        '/root/.gemini/oauth_creds.json',
        '/home/user/.gemini/oauth_creds.json',
        str(Path.home() / '.gemini' / 'oauth_creds.json'),
    ])
    if not (has_agy_tok or has_oauth_creds or env.get('GEMINI_API_KEY')):
        sys.stderr.write("Antigravity / Gemini credentials not found in this VM. Click 'Connect in VM' to sign in.\\n")
        sys.exit(1)

    if has_oauth_creds:
        env['GOOGLE_GENAI_USE_GCA'] = 'true'

    if agy_bin:
        if has_mcp:
            try:
                mcp_res = subprocess.run(
                    [
                        agy_bin, 'mcp', 'add',
                        '--env', f'WORKSPACE_ROOT={cwd}',
                        '--env', 'DISPLAY=:1',
                        'neuronrunner',
                        'python3', mcp_server_path,
                    ],
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=15,
                )
                if mcp_res.returncode != 0:
                    sys.stderr.write(f'Warning: agy mcp add failed (exit {mcp_res.returncode}): {mcp_res.stderr or mcp_res.stdout}\\n')
            except (subprocess.TimeoutExpired, OSError) as exc:
                sys.stderr.write(f'Warning: agy mcp add failed: {exc}\\n')
        cmd = [
            agy_bin, '-p', prompt,
            '--model', model_id,
            '--output-format', 'stream-json',
            '--dangerously-skip-permissions',
        ]
    else:
        cli = ensure_cli('gemini', '@google/gemini-cli')
        if has_mcp:
            import fcntl
            settings_file = gemini_dir / 'settings.json'
            lock_file = gemini_dir / 'settings.json.lock'
            with open(lock_file, 'w', encoding='utf-8') as lock_fh:
                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
                try:
                    try:
                        settings_data = json.loads(settings_file.read_text(encoding='utf-8')) if settings_file.is_file() else {}
                    except Exception:
                        settings_data = {}
                    if not isinstance(settings_data, dict):
                        settings_data = {}
                    mcp_servers = settings_data.get('mcpServers')
                    if not isinstance(mcp_servers, dict):
                        mcp_servers = {}
                    mcp_servers['neuronrunner'] = {
                        'command': 'python3',
                        'args': [mcp_server_path],
                        'env': {'WORKSPACE_ROOT': cwd, 'DISPLAY': ':1'},
                    }
                    settings_data['mcpServers'] = mcp_servers
                    settings_file.write_text(json.dumps(settings_data, indent=2), encoding='utf-8')
                finally:
                    fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
        cmd = [
            cli, '-p', prompt,
            '-m', model_id,
            '--output-format', 'stream-json',
            '--yolo',
        ]
else:
    sys.stderr.write(f'Unsupported BYOS provider: {provider}\\n')
    sys.exit(1)

try:
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, bufsize=1)
    sys.exit(proc.wait())
finally:
    if temp_mcp_cfg_path:
        try:
            Path(temp_mcp_cfg_path).unlink(missing_ok=True)
        except OSError:
            pass
"""


def is_byos_model(model) -> bool:
    """Return True when the model executes via a BYOS subscription CLI inside the VM."""
    return getattr(model, 'provider_name', '') in BYOS_PROVIDERS


def _extract_message_text(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                txt = str(item.get('text') or '').strip()
                if txt:
                    parts.append(txt)
        return '\n'.join(parts).strip()
    return str(content or '').strip()


def build_byos_prompt(
    messages: list[dict],
    *,
    system_prompt: str | None = None,
    attachments_context: str | None = None,
    cwd: str = '/workspace',
    has_desktop_mcp: bool = False,
) -> str:
    """Build a clean standalone prompt for CLI agents, excluding NeuronRunner internal API tool docs."""
    turns: list[tuple[str, str]] = []
    for msg in messages or []:
        role = msg.get('role')
        if role not in ('user', 'assistant'):
            continue
        text = _extract_message_text(msg.get('content'))
        if text:
            turns.append((role, text))

    parts: list[str] = []
    if system_prompt and system_prompt.strip():
        parts.append(f"System instructions:\n{system_prompt.strip()}")
    if attachments_context and attachments_context.strip():
        parts.append(attachments_context.strip())
    parts.append(f"Workspace directory: {cwd}")
    if has_desktop_mcp:
        parts.append(
            "Desktop environment:\n"
            "You have access to the `desktop` tool (via MCP) to control the live Linux desktop "
            "(DISPLAY :1, with virtual speaker nr_speaker). When the user asks you to open the desktop, "
            "use a GUI/browser on the desktop, take a screenshot, or interact with GUI apps, call the "
            "`desktop` tool immediately—calling it automatically starts the desktop if needed and opens "
            "the live Desktop panel in the user's UI so they can watch in real time."
        )

    if len(turns) > 1:
        history_lines = []
        for role, text in turns[:-1]:
            label = 'User' if role == 'user' else 'Assistant'
            history_lines.append(f"{label}: {text}")
        parts.append("Conversation history:\n" + "\n\n".join(history_lines))

    if turns:
        parts.append(f"Current request:\n{turns[-1][1]}")
    else:
        parts.append("Current request:\nHello")

    return "\n\n".join(parts)


def _extract_claude_text_blocks(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get('text'), str):
                chunks.append(block['text'])
            elif isinstance(block, str):
                chunks.append(block)
        return '\n'.join(chunks)
    return str(content or '')


def _usage_event(usage: dict | None) -> dict | None:
    if not isinstance(usage, dict):
        return None
    input_tokens = int(usage.get('input_tokens') or usage.get('prompt_tokens') or 0)
    output_tokens = int(usage.get('output_tokens') or usage.get('completion_tokens') or 0)
    cached_tokens = int(
        usage.get('cache_read_input_tokens')
        or usage.get('cached_input_tokens')
        or usage.get('cache_read_tokens')
        or usage.get('cached')
        or 0
    )
    if input_tokens or output_tokens or cached_tokens:
        return {
            'kind': 'usage',
            'input_tokens': input_tokens + int(usage.get('cache_creation_input_tokens') or 0),
            'output_tokens': output_tokens,
            'cached_tokens': cached_tokens,
        }
    return None


def _normalize_byos_tool_name(name: str) -> str:
    if name in (
        'desktop',
        'mcp__neuronrunner__desktop',
        'neuronrunner__desktop',
        'mcp_neuronrunner_desktop',
        'neuronrunner_desktop',
        'neuronrunner:desktop',
        'neuronrunner/desktop',
    ):
        return 'desktop'
    return name


def _normalize_codex_tool_item(item: dict) -> tuple[str, dict, dict]:
    itype = item.get('type') or 'tool'
    if itype == 'command_execution':
        name = 'shell_exec'
        args = {'command': item.get('command', '')}
        result = {
            'output': item.get('aggregated_output', ''),
            'exit_code': item.get('exit_code'),
            'status': item.get('status'),
        }
    elif itype == 'file_change':
        name = 'file_write'
        args = {'changes': item.get('changes', [])}
        result = {'changes': item.get('changes', []), 'status': item.get('status')}
    elif itype == 'mcp_tool_call':
        name = _normalize_byos_tool_name(item.get('tool') or 'mcp_tool')
        args = item.get('arguments') if isinstance(item.get('arguments'), dict) else {}
        result = item.get('result') if item.get('result') is not None else {'status': item.get('status') or 'ok'}
    elif itype == 'web_search':
        name = 'web_search'
        action = item.get('action') if isinstance(item.get('action'), dict) else {}
        query = str(item.get('query') or action.get('query') or '').strip()
        url = str(action.get('url') or '').strip()
        pattern = str(action.get('pattern') or '').strip()
        args = {}
        if query:
            args['query'] = query
        elif url:
            args['url'] = url
        elif pattern:
            args['pattern'] = pattern
        raw_results = item.get('results') if isinstance(item.get('results'), list) else []
        formatted_results = []
        for entry in raw_results:
            if not isinstance(entry, dict):
                continue
            r_url = str(entry.get('url') or '').strip()
            r_title = str(entry.get('title') or r_url).strip()
            r_snippet = str(entry.get('snippet') or '').strip()[:500]
            if r_url or r_title or r_snippet:
                formatted_results.append({
                    'title': r_title,
                    'url': r_url,
                    'snippet': r_snippet,
                })
        status_val = item.get('status')
        result = {
            'status': 'error' if status_val == 'failed' else 'ok',
            'query': query or url or pattern,
            'count': len(formatted_results),
            'results': formatted_results,
        }
    else:
        name = itype
        args = {k: v for k, v in item.items() if k not in ('id', 'type', 'status')}
        result = item.get('result') if item.get('result') is not None else {'status': item.get('status') or 'ok'}
    return name, args, result


def _normalize_anthropic_event(event: dict) -> list[dict]:
    out: list[dict] = []
    etype = event.get('type')

    if etype == 'stream_event':
        inner = event.get('event') or {}
        if inner.get('type') == 'content_block_delta':
            delta = inner.get('delta') or {}
            dtype = delta.get('type')
            if dtype == 'text_delta' and delta.get('text'):
                out.append({'kind': 'text', 'text': delta['text']})
            elif dtype == 'thinking_delta' and delta.get('thinking'):
                out.append({'kind': 'thinking', 'text': delta['thinking']})
        return out

    if etype == 'assistant':
        msg = event.get('message') or {}
        for block in msg.get('content') or []:
            if not isinstance(block, dict):
                continue
            btype = block.get('type')
            if btype == 'thinking' and block.get('thinking'):
                out.append({'kind': 'thinking', 'text': block['thinking']})
            elif btype == 'text' and block.get('text'):
                out.append({'kind': 'text', 'text': block['text']})
            elif btype == 'tool_use':
                name = _normalize_byos_tool_name(block.get('name') or 'tool')
                out.append({
                    'kind': 'tool_call',
                    'id': block.get('id') or '',
                    'name': name,
                    'arguments': json.dumps(block.get('input') or {}, ensure_ascii=False),
                    'title': format_tool_name(name),
                })
        usage_evt = _usage_event(msg.get('usage'))
        if usage_evt:
            out.append(usage_evt)
        return out

    if etype == 'user':
        msg = event.get('message') or {}
        for block in msg.get('content') or []:
            if not isinstance(block, dict) or block.get('type') != 'tool_result':
                continue
            out.append({
                'kind': 'tool_result',
                'id': block.get('tool_use_id') or '',
                'name': _normalize_byos_tool_name(block.get('tool_name') or ''),
                'result': {
                    'output': _extract_claude_text_blocks(block.get('content')),
                    'is_error': bool(block.get('is_error')),
                },
            })
        return out

    if etype == 'result':
        usage_evt = _usage_event(event.get('usage'))
        if usage_evt:
            out.append(usage_evt)
        if event.get('is_error'):
            err = event.get('result') or event.get('error') or 'Claude Code CLI failed.'
            out.append({'kind': 'error', 'message': str(err)})
        elif event.get('result'):
            out.append({'kind': 'result_fallback', 'text': str(event['result'])})
        return out

    if etype == 'error':
        err = event.get('error')
        msg = err.get('message') if isinstance(err, dict) else (event.get('message') or err or 'CLI execution error.')
        out.append({'kind': 'error', 'message': str(msg)})
    return out


def _normalize_openai_event(event: dict) -> list[dict]:
    out: list[dict] = []
    etype = event.get('type')

    if etype in ('item.started', 'item.completed'):
        item = event.get('item') or {}
        itype = item.get('type')
        if itype == 'reasoning' and etype == 'item.completed' and item.get('text'):
            out.append({'kind': 'thinking', 'text': item['text']})
        elif itype == 'agent_message' and etype == 'item.completed' and item.get('text'):
            out.append({'kind': 'text', 'text': item['text']})
        elif itype in ('command_execution', 'file_change', 'mcp_tool_call', 'web_search'):
            name, args, result = _normalize_codex_tool_item(item)
            call_id = item.get('id') or ''
            out.append({
                'kind': 'tool_call',
                'id': call_id,
                'name': name,
                'arguments': json.dumps(args, ensure_ascii=False),
                'title': format_tool_name(name),
            })
            if etype == 'item.completed':
                out.append({
                    'kind': 'tool_result',
                    'id': call_id,
                    'name': name,
                    'result': result,
                })
        return out

    if etype == 'turn.completed':
        usage_evt = _usage_event(event.get('usage'))
        if usage_evt:
            out.append(usage_evt)
        return out

    if etype in ('turn.failed', 'error'):
        err = event.get('error')
        msg = err.get('message') if isinstance(err, dict) else (event.get('message') or 'Codex CLI failed.')
        out.append({'kind': 'error', 'message': str(msg)})
    return out


def _synthesize_antigravity_tool_output(name: str, params: dict) -> str:
    """Build a unified diff preview when Antigravity edit/write tools omit output."""
    if not isinstance(params, dict) or not params:
        return ''
    lower = (name or '').lower()
    path = (
        params.get('Path')
        or params.get('path')
        or params.get('TargetFile')
        or params.get('file_path')
        or params.get('filepath')
        or 'file'
    )
    if any(tok in lower for tok in ('edit', 'replace', 'patch')):
        for old_key, new_key in (
            ('Target', 'Replacement'),
            ('TargetContent', 'ReplacementContent'),
            ('old_string', 'new_string'),
            ('old_str', 'new_str'),
        ):
            old_val = params.get(old_key)
            new_val = params.get(new_key)
            if isinstance(old_val, str) and isinstance(new_val, str) and (old_val or new_val):
                diff_lines = list(difflib.unified_diff(
                    old_val.splitlines(),
                    new_val.splitlines(),
                    fromfile=f'a/{path}',
                    tofile=f'b/{path}',
                    lineterm='',
                ))
                return '\n'.join(diff_lines)
    if any(tok in lower for tok in ('write', 'create_file')):
        content = params.get('Content') or params.get('content') or params.get('CodeContent')
        if isinstance(content, str) and content:
            lines = content.splitlines()
            truncated = len(lines) > 120
            preview_lines = lines[:120]
            diff_lines = list(difflib.unified_diff(
                [],
                preview_lines,
                fromfile='/dev/null',
                tofile=f'b/{path}',
                lineterm='',
            ))
            if truncated:
                diff_lines.append(f'... ({len(lines) - 120} more lines)')
            return '\n'.join(diff_lines)
    return ''


def _normalize_antigravity_event(event: dict) -> list[dict]:
    out: list[dict] = []
    # Current `agy --output-format stream-json` schema uses `event` + nested payload.
    evt_kind = event.get('event')
    if evt_kind == 'step_update':
        su = event.get('step_update') or {}
        step_type = su.get('step_type')
        if step_type == 'agent_response':
            if su.get('thinking_delta'):
                out.append({'kind': 'thinking', 'text': str(su['thinking_delta'])})
            elif su.get('thinking'):
                out.append({'kind': 'thinking', 'text': str(su['thinking'])})
            if su.get('text_delta'):
                out.append({'kind': 'text', 'text': str(su['text_delta'])})
            usage_evt = _usage_event(su.get('usage'))
            if usage_evt:
                out.append(usage_evt)
        elif step_type == 'tool':
            state = str(su.get('state') or '').upper()
            tool_info = su.get('tool_info') if isinstance(su.get('tool_info'), dict) else {}
            name = _normalize_byos_tool_name(su.get('tool_name') or tool_info.get('name') or 'tool')
            call_id = su.get('tool_id') or tool_info.get('id') or f"agy_step_{su.get('step_index', 0)}"
            params = tool_info.get('parameters') if isinstance(tool_info.get('parameters'), dict) else {}
            if state == 'ACTIVE' or state == 'DONE':
                out.append({
                    'kind': 'tool_call',
                    'id': call_id,
                    'name': name,
                    'arguments': json.dumps(params, ensure_ascii=False),
                    'title': format_tool_name(name),
                })
            if state == 'DONE':
                err_val = tool_info.get('error')
                output_val = tool_info.get('output')
                if not err_val and not output_val:
                    output_val = _synthesize_antigravity_tool_output(name, params)
                out.append({
                    'kind': 'tool_result',
                    'id': call_id,
                    'name': name,
                    'result': {'output': output_val or err_val or '', 'status': 'error' if err_val else 'success'},
                    'is_error': bool(err_val),
                })
        return out

    if evt_kind == 'result':
        res = event.get('result') or {}
        usage_evt = _usage_event(res.get('usage'))
        if usage_evt:
            out.append(usage_evt)
        status = str(res.get('status') or '').upper()
        if status in ('ERROR', 'FAILED', 'CANCELLED') or res.get('error'):
            err_msg = res.get('error') or res.get('message') or res.get('response') or f'Antigravity CLI failed ({status}).'
            out.append({'kind': 'error', 'message': str(err_msg)})
        elif res.get('response'):
            out.append({'kind': 'result_fallback', 'text': str(res['response'])})
        return out

    if evt_kind == 'error':
        err = event.get('error')
        msg = err.get('message') if isinstance(err, dict) else (event.get('message') or err or 'Antigravity CLI error.')
        out.append({'kind': 'error', 'message': str(msg)})
        return out

    if evt_kind:
        return out

    etype = event.get('type')
    if etype in ('stream_event', 'assistant', 'user'):
        return _normalize_anthropic_event(event)
    if etype == 'message' and event.get('role') == 'assistant' and event.get('content'):
        out.append({'kind': 'text', 'text': str(event['content'])})
    elif etype == 'tool_use':
        name = _normalize_byos_tool_name(event.get('tool_name') or event.get('name') or 'tool')
        out.append({
            'kind': 'tool_call',
            'id': event.get('tool_id') or event.get('id') or '',
            'name': name,
            'arguments': json.dumps(event.get('parameters') or event.get('input') or {}, ensure_ascii=False),
            'title': format_tool_name(name),
        })
    elif etype == 'tool_result':
        out.append({
            'kind': 'tool_result',
            'id': event.get('tool_id') or event.get('id') or '',
            'name': _normalize_byos_tool_name(event.get('tool_name') or event.get('name') or 'tool'),
            'result': {'output': event.get('output') or '', 'status': event.get('status') or 'success'},
            'is_error': event.get('status') == 'error',
        })
    elif etype == 'result':
        stats = event.get('stats') or {}
        usage_evt = _usage_event(stats)
        if usage_evt:
            out.append(usage_evt)
    elif etype == 'error' and event.get('message'):
        out.append({'kind': 'error', 'message': str(event['message'])})
    return out


def normalize_byos_line(provider: str, line: str) -> list[dict]:
    """Parse one stdout line from Claude Code or Codex CLI into normalized internal events."""
    raw = (line or '').strip()
    if not raw:
        return []
    try:
        event = json.loads(raw)
    except (ValueError, TypeError):
        return [{'kind': 'text', 'text': raw + '\n'}]
    if not isinstance(event, dict):
        return [{'kind': 'text', 'text': raw + '\n'}]
    if provider == 'anthropic_sub':
        return _normalize_anthropic_event(event)
    if provider == 'openai_sub':
        return _normalize_openai_event(event)
    if provider == 'antigravity_sub':
        return _normalize_antigravity_event(event)
    return []


def _resolve_active_project_and_runtime(conversation, workspace, user, *, allow_start: bool = True):
    from sandbox.services.sandbox_service import SandboxBootstrapService
    from sandbox.services.sandbox_session import get_sandbox_manager

    project = SandboxBootstrapService.conversation_project(conversation)
    if not project:
        project = SandboxBootstrapService.ensure_workspace_sandbox(workspace)

    manager = get_sandbox_manager()
    runtime = manager.get_or_create(project, runtime=getattr(conversation, 'runtime_name', '') or '')
    return project, runtime


def _encode_runner_arg(runtime, payload: dict, suffix_id: str) -> str:
    encoded = base64.b64encode(json.dumps(payload).encode('utf-8')).decode('ascii')
    if len(encoded) > 90000 and hasattr(runtime, 'fs'):
        payload_path = f"/tmp/nr-byos-{suffix_id}.json"
        runtime.fs.write_text(payload_path, json.dumps(payload))
        return f"file:{payload_path}"
    return encoded


def _ensure_byos_mcp_files(runtime) -> bool:
    """Sync guest desktop & MCP server scripts into /var/lib/neuronrunner when runtime.fs is available."""
    fs = getattr(runtime, 'fs', None)
    write_text = getattr(fs, 'write_text', None)
    if not callable(write_text):
        return True
    services_dir = Path(__file__).resolve().parents[2] / 'sandbox' / 'services'
    files = (
        ('file_tools.py', '/var/lib/neuronrunner/file_tools.py'),
        ('byos_mcp_server.py', '/var/lib/neuronrunner/byos_mcp_server.py'),
    )
    all_ok = True
    for src_name, dst_path in files:
        src_path = services_dir / src_name
        if not src_path.is_file():
            all_ok = False
            continue
        try:
            write_text(dst_path, src_path.read_text(encoding='utf-8'))
        except Exception as exc:
            logger.debug('Failed to sync %s to VM: %s', dst_path, exc)
            all_ok = False
    return all_ok


def stream_byos_cli(
    chat_service,
    phases: list,
    tool_round: int,
    all_thinking_parts: list | None = None,
    all_tool_calls: list | None = None,
):
    """Execute a workspace BYOS CLI session in the workspace container and yield SSE events."""
    all_thinking_parts = all_thinking_parts if all_thinking_parts is not None else []
    all_tool_calls = all_tool_calls if all_tool_calls is not None else []

    credentials_for_request(chat_service.model_tag, chat_service.current_request)
    provider = chat_service.current_request.provider or getattr(chat_service.model_tag, 'provider_name', '')
    project, runtime = _resolve_active_project_and_runtime(
        chat_service.conversation,
        chat_service.current_request.workspace,
        chat_service.current_request.user,
    )

    has_desktop_mcp = False

    cwd = getattr(project, 'filesystem_path', None) or '/workspace'
    prompt = build_byos_prompt(
        chat_service.messages,
        system_prompt=getattr(chat_service, 'system_prompt', None),
        attachments_context=getattr(chat_service, 'attachments_context', None),
        cwd=cwd,
        has_desktop_mcp=has_desktop_mcp,
    )
    reasoning_effort = ''
    if hasattr(chat_service, '_resolve_reasoning_effort'):
        reasoning_effort = chat_service._resolve_reasoning_effort() or ''
    payload = {
        'provider': provider,
        'model_id': chat_service.model_tag.external_model_id,
        'prompt': prompt,
        'reasoning_effort': reasoning_effort,
        'cwd': cwd,
    }
    runner_arg = _encode_runner_arg(runtime, payload, str(chat_service.current_request.uuid))

    proc = runtime.exec('python3', '-u', '-c', _GUEST_BYOS_RUNNER, runner_arg, timeout=1800)

    line_queue: Queue = Queue()
    errors: list[str] = []
    stream_state: dict[str, object] = {'finished': False, 'error': None}

    def read_stdout():
        try:
            for line in proc.stdout:
                line_queue.put(line)
        except Exception as exc:
            stream_state['error'] = str(exc)
        finally:
            stream_state['finished'] = True
            line_queue.put(None)

    def read_stderr():
        if getattr(proc, 'stderr', None):
            with suppress(Exception):
                raw = proc.stderr.read()
                text = raw.decode('utf-8', errors='replace') if isinstance(raw, bytes) else str(raw)
                if text:
                    errors.append(text)

    stdout_thread = Thread(target=read_stdout, daemon=True)
    stderr_thread = Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    full_response = ''
    full_thinking = ''
    input_tokens = 0
    output_tokens = 0
    thinking_start = None
    thinking_duration_ms = None
    tool_calls_by_id: dict[str, dict] = {}
    tool_phase_indices: dict[str, int] = {}
    tool_started_at: dict[str, float] = {}

    try:
        while True:
            chat_service._raise_if_canceled(force=False)
            try:
                line = line_queue.get(timeout=0.5)
            except Empty:
                if stream_state['error'] is not None:
                    raise RuntimeError(str(stream_state['error']))
                if stream_state['finished'] and line_queue.empty():
                    break
                continue

            if line is None:
                if stream_state['error'] is not None:
                    raise RuntimeError(str(stream_state['error']))
                break

            for evt in normalize_byos_line(provider, line):
                kind = evt['kind']
                if kind == 'error':
                    raise RuntimeError(evt['message'])
                if kind == 'usage':
                    input_tokens = max(input_tokens, int(evt.get('input_tokens') or 0))
                    output_tokens = max(output_tokens, int(evt.get('output_tokens') or 0))
                    cached = int(evt.get('cached_tokens') or 0)
                    if cached and chat_service.current_request.cached_input_tokens != cached:
                        chat_service.current_request.cached_input_tokens = cached
                        chat_service.current_request.save(update_fields=['cached_input_tokens'])
                    chat_service._persist_token_snapshot(
                        input_tokens=chat_service._billed_input_tokens + input_tokens,
                        output_tokens=chat_service._billed_output_tokens + output_tokens,
                    )
                    continue

                if kind == 'thinking':
                    delta = evt['text']
                    if thinking_start is None:
                        thinking_start = time.monotonic()
                    full_thinking += delta
                    chat_service._append_stream_phase(phases, 'thinking', delta, tool_round)
                    yield sse_event('thinking', {'v': delta})
                    combined = '\n\n'.join(all_thinking_parts + [full_thinking])
                    chat_service._update_partial_state(
                        content=full_response, thinking=combined, phases=phases, tool_calls=all_tool_calls
                    )
                elif kind == 'text':
                    delta = evt['text']
                    if thinking_start is not None and thinking_duration_ms is None:
                        thinking_duration_ms = (time.monotonic() - thinking_start) * 1000
                        if phases and phases[-1].get('type') == 'thinking':
                            phases[-1]['durationMs'] = int(thinking_duration_ms)
                            phases[-1]['streaming'] = False
                    full_response += delta
                    chat_service._append_stream_phase(phases, 'content', delta, tool_round)
                    yield sse_event('message', {'v': delta})
                    combined = '\n\n'.join(all_thinking_parts + [full_thinking]) if (all_thinking_parts or full_thinking) else ''
                    chat_service._update_partial_state(
                        content=full_response, thinking=combined, phases=phases, tool_calls=all_tool_calls
                    )
                elif kind == 'result_fallback':
                    if not full_response and evt.get('text'):
                        delta = evt['text']
                        full_response += delta
                        chat_service._append_stream_phase(phases, 'content', delta, tool_round)
                        yield sse_event('message', {'v': delta})
                elif kind == 'tool_call':
                    call_id = evt.get('id') or f"byos_tc_{len(all_tool_calls)}"
                    new_args = evt.get('arguments') or '{}'
                    if call_id in tool_calls_by_id:
                        existing_tc = tool_calls_by_id[call_id]
                        if new_args not in ('{}', '', existing_tc['function']['arguments']):
                            existing_tc['function']['arguments'] = new_args
                            yield sse_event('tool_call', existing_tc)
                            combined = '\n\n'.join(all_thinking_parts + [full_thinking]) if (all_thinking_parts or full_thinking) else ''
                            chat_service._update_partial_state(
                                content=full_response, thinking=combined, phases=phases, tool_calls=all_tool_calls, force=True
                            )
                        continue
                    if thinking_start is not None and thinking_duration_ms is None:
                        thinking_duration_ms = (time.monotonic() - thinking_start) * 1000
                        if phases and phases[-1].get('type') == 'thinking':
                            phases[-1]['durationMs'] = int(thinking_duration_ms)
                            phases[-1]['streaming'] = False
                    tc = {
                        'id': call_id,
                        'type': 'function',
                        'index': len(all_tool_calls),
                        'function': {
                            'name': evt['name'],
                            'arguments': evt.get('arguments') or '{}',
                        },
                        'title': evt.get('title') or format_tool_name(evt['name']),
                    }
                    tool_calls_by_id[call_id] = tc
                    tool_started_at[call_id] = time.monotonic()
                    all_tool_calls.append(tc)
                    phases.append({
                        'type': 'tool_call',
                        'label': tc['title'],
                        'title': tc['title'],
                        'toolName': evt['name'],
                        'toolCallId': call_id,
                    })
                    tool_phase_indices[call_id] = len(phases) - 1
                    yield sse_event('tool_call', tc)
                    combined = '\n\n'.join(all_thinking_parts + [full_thinking]) if (all_thinking_parts or full_thinking) else ''
                    chat_service._update_partial_state(
                        content=full_response, thinking=combined, phases=phases, tool_calls=all_tool_calls, force=True
                    )
                elif kind == 'tool_result':
                    call_id = evt.get('id') or ''
                    tc = tool_calls_by_id.get(call_id)
                    fn_name = evt.get('name') or (tc['function']['name'] if tc else 'tool')
                    title = tc['title'] if tc else format_tool_name(fn_name)
                    elapsed_ms = (time.monotonic() - tool_started_at.get(call_id, time.monotonic())) * 1000
                    result = evt.get('result') or {}
                    if tc is not None:
                        tc['result'] = result
                        tc['duration_ms'] = elapsed_ms
                    phase_idx = tool_phase_indices.get(call_id)
                    if phase_idx is not None and phase_idx < len(phases):
                        phases[phase_idx] = {
                            'type': 'tool_result',
                            'label': f"{title}: {elapsed_ms / 1000:.1f}s",
                            'title': title,
                            'toolName': fn_name,
                            'toolCallId': call_id,
                        }
                    yield sse_event('tool_result', {
                        'name': fn_name,
                        'result': result,
                        'id': call_id,
                        'duration_ms': elapsed_ms,
                    })
                    combined = '\n\n'.join(all_thinking_parts + [full_thinking]) if (all_thinking_parts or full_thinking) else ''
                    chat_service._update_partial_state(
                        content=full_response, thinking=combined, phases=phases, tool_calls=all_tool_calls, force=True
                    )

        exit_code = proc.wait(30)
        stderr_thread.join(timeout=1)
        if exit_code not in (0, None) and not full_response:
            err_detail = ''.join(errors).strip() or f'CLI exited with code {exit_code}.'
            raise RuntimeError(f'BYOS CLI failed: {err_detail}')

    except Exception:
        with suppress(Exception):
            kill_fn = getattr(proc, 'kill', None)
            if callable(kill_fn):
                kill_fn()
        raise
    finally:
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        if input_tokens or output_tokens:
            chat_service._persist_token_snapshot(
                input_tokens=chat_service._billed_input_tokens + input_tokens,
                output_tokens=chat_service._billed_output_tokens + output_tokens,
            )

    if thinking_start is not None and thinking_duration_ms is None:
        thinking_duration_ms = (time.monotonic() - thinking_start) * 1000
        if phases and phases[-1].get('type') == 'thinking':
            phases[-1]['durationMs'] = int(thinking_duration_ms)
            phases[-1]['streaming'] = False

    return full_response, full_thinking, input_tokens, output_tokens, [], thinking_duration_ms


def run_byos_cli_sync(chat_service) -> tuple[str, str, int, int, list]:
    """Run BYOS CLI synchronously and return (content, thinking, input_tokens, output_tokens, tool_calls)."""
    phases: list = []
    all_tool_calls: list = []
    gen = stream_byos_cli(chat_service, phases, 1, [], all_tool_calls)
    while True:
        try:
            next(gen)
        except StopIteration as stop:
            full_response, full_thinking, input_tokens, output_tokens, _tc, _dur = stop.value
            return full_response, full_thinking, input_tokens, output_tokens, []
