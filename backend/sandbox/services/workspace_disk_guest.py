"""Stdlib-only VM filesystem operations with project and symlink confinement."""
import base64
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

WORKSPACE_ROOT = Path('/workspace')


def operate(request):
    root = Path(request['root']).resolve()
    workspace = WORKSPACE_ROOT.resolve()
    if not root.is_relative_to(workspace):
        raise ValueError('Project directory is outside /workspace')
    root.mkdir(parents=True, exist_ok=True)

    def target(relative):
        path = (root / relative).resolve()
        if not path.is_relative_to(root):
            raise ValueError('Path is outside the project directory')
        return path

    path = target(request['path'])
    action = request['action']
    if action == 'list':
        entries = [{'path': '/workspace', 'is_dir': True, 'size': 0, 'mtime': int(root.stat().st_mtime)}]
        for current, dirs, files in os.walk(root, followlinks=False):
            for name in sorted(dirs + files):
                item = Path(current) / name
                if not item.resolve().is_relative_to(root):
                    continue
                try:
                    file_stat = item.stat()
                except FileNotFoundError:
                    continue
                entries.append({'path': '/workspace/' + item.relative_to(root).as_posix(),
                                'is_dir': item.is_dir(), 'size': 0 if item.is_dir() else file_stat.st_size,
                                'mtime': int(file_stat.st_mtime)})
                if len(entries) >= 20000:
                    return {'entries': sorted(entries, key=lambda item: item['path'])}
            dirs[:] = [name for name in dirs if name not in {'.git', 'node_modules', '.venv', '__pycache__', '.next'}
                       and not (Path(current) / name).is_symlink()]
        return {'entries': sorted(entries, key=lambda item: item['path'])}
    if action == 'read':
        if not path.is_file():
            return {}
        if path.stat().st_size > 100 * 1024 * 1024:
            raise ValueError('This file is too large to read through the workspace API')
        return {'data': base64.b64encode(path.read_bytes()).decode()}
    if action == 'write':
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.nr-write-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                shutil.copyfileobj(sys.stdin.buffer, stream)
            os.chmod(temporary, stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    elif action == 'mkdir':
        path.mkdir(parents=True, exist_ok=True)
    elif action == 'remove':
        if path == root:
            raise ValueError('The workspace root cannot be deleted')
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    elif action == 'rename':
        destination = target(request['new_path'])
        if path == root or destination == root:
            raise ValueError('The workspace root cannot be renamed or replaced')
        if destination.exists():
            raise ValueError('The destination already exists')
        destination.parent.mkdir(parents=True, exist_ok=True)
        path.rename(destination)
    else:
        raise ValueError('Unknown workspace disk operation')
    return {'success': True}


if __name__ == '__main__':
    try:
        print(json.dumps(operate(json.loads(sys.argv[1]))))
    except (ValueError, OSError) as exc:
        print(json.dumps({'error': str(exc)}))
