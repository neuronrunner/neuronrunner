"""Local MCP commands may run only in an authorized workspace runtime."""
import json
from pathlib import Path

from django.conf import settings
from rest_framework.exceptions import PermissionDenied, ValidationError


def authorized_workspace(user_uuid, workspace_uuid):
    from sandbox.models import Workspace

    if not user_uuid or not workspace_uuid:
        raise ValidationError({'workspace': 'Select a workspace sandbox for local MCP commands.'})
    workspace = Workspace.objects.filter(
        pk=workspace_uuid, memberships__user_id=user_uuid,
        memberships__user__is_active=True,
    ).first()
    if workspace is None:
        raise PermissionDenied('You no longer have access to this MCP workspace sandbox.')
    return workspace


def run_stdio(command, env_json, *, user_uuid, workspace_uuid, timeout, tool_name=None, arguments=None):
    # Check membership on every operation, including discovery and existing chats.
    # Never use a local subprocess as a fallback when provisioning/exec fails.
    workspace = authorized_workspace(user_uuid, workspace_uuid)
    from sandbox.services.sandbox_service import SandboxBootstrapService
    from sandbox.services.sandbox_session import get_sandbox_manager
    from .playwright_guest import managed_playwright

    startup_timeout = max(timeout, getattr(settings, 'MCP_STDIO_STARTUP_TIMEOUT', 120))
    if tool_name is not None and managed_playwright(command, env_json or {}):
        startup_timeout = max(startup_timeout, 360)
    execution_timeout = startup_timeout + timeout + 5
    request = json.dumps({
        'command': command, 'env': env_json or {}, 'timeout': timeout,
        'startup_timeout': startup_timeout,
        'tool_name': tool_name, 'arguments': arguments or {},
    })
    if len(request.encode()) > 65536:
        raise ValidationError('MCP request exceeds the sandbox transport limit (64 KiB).')
    project = SandboxBootstrapService.ensure_workspace_sandbox(workspace)
    runtime = get_sandbox_manager().get_or_create(project)
    code = Path(__file__).with_name('stdio_guest.py').read_text(encoding='utf-8')
    code = Path(__file__).with_name('playwright_guest.py').read_text(encoding='utf-8') + '\n' + code
    process = runtime.exec('python3', '-I', '-u', '-c', code, request, timeout=execution_timeout)
    # Read before waiting: Docker/remote pipes can fill while producing output.
    output = process.stdout.read()
    exit_code = process.wait(execution_timeout)
    if exit_code != 0:
        raise RuntimeError('The MCP sandbox process failed. Check the sandbox runtime and installed commands.')
    try:
        response = json.loads(output)
    except (ValueError, TypeError) as exc:
        raise RuntimeError('The MCP sandbox returned an invalid response.') from exc
    if response.get('timeout'):
        raise TimeoutError(response.get('error') or 'MCP operation timed out inside the workspace sandbox.')
    if response.get('error'):
        raise RuntimeError(response['error'])
    return response['result']
