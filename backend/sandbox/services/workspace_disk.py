"""Workspace files live inside the workspace Docker container's /workspace mount."""
import json
from pathlib import Path, PurePosixPath


def relative_path(path):
    raw = str(path or '').strip()
    if '\x00' in raw or '\\' in raw:
        raise ValueError('Choose a path inside /workspace')
    if raw == '/workspace':
        return ''
    if raw.startswith('/workspace/'):
        raw = raw[len('/workspace/'):]
    elif raw.startswith('/'):
        raise ValueError('Choose a path inside /workspace')
    if any(part in ('.', '..') for part in raw.split('/')):
        raise ValueError('Choose a path inside /workspace')
    return PurePosixPath(raw).as_posix() if raw else ''


def operation(project, action, path='/workspace', new_path=None, data=None):
    from .sandbox_session import get_sandbox_manager
    # Validate before waking a VM, including a stored project directory.
    root = (project.filesystem_path or f'/workspace/{project.slug}').rstrip('/')
    relative_path(root)
    request = {'root': root, 'action': action, 'path': relative_path(path)}
    if new_path is not None:
        request['new_path'] = relative_path(new_path)
    if action in ('remove', 'rename') and not request['path']:
        raise ValueError('The workspace root cannot be deleted or renamed')
    if action == 'rename' and not request['new_path']:
        raise ValueError('The workspace root cannot be replaced')
    from core.extensions import registry as ext_registry
    if ext_registry.runtime.workspace_disk_override is not None:
        # An extension may serve the operation without a running runtime (for example a closed VM over its quota).
        handled = ext_registry.runtime.workspace_disk_override(project, action, path, new_path, data)
        if handled is not None:
            return handled
    runtime = get_sandbox_manager().get_or_create(project)
    code = Path(__file__).with_name('workspace_disk_guest.py').read_text()
    kwargs = {'stdin': data} if data is not None else {}
    proc = runtime.exec('python3', '-c', code, json.dumps(request), timeout=120, **kwargs)
    output = proc.stdout.read()
    if proc.wait(120) != 0:
        raise RuntimeError('Workspace disk operation failed')
    result = json.loads(output)
    if result.get('error'):
        raise ValueError(result['error'])
    return result


def list_tree(project):
    return operation(project, 'list')['entries']


def read_file(project, path):
    import base64
    result = operation(project, 'read', path)
    return base64.b64decode(result['data']) if 'data' in result else None


def write_file(project, path, data):
    if isinstance(data, str):
        data = data.encode()
    operation(project, 'write', path, data=data)


def mkdir(project, path):
    return operation(project, 'mkdir', path)


def remove(project, path):
    operation(project, 'remove', path)


def rename(project, old, new):
    return operation(project, 'rename', old, new_path=new)
