"""
File tools for agent sandbox operations.
All operations run inside the user's project sandbox.
"""
from __future__ import annotations

import glob
import errno
import logging
import os
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

try:
    from django.conf import settings
except ImportError:
    settings = None

logger = logging.getLogger(__name__)

WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace")
SECRETS_PATH = Path("/var/lib/neuronrunner/secrets.json")
_RESERVED_ENV_KEYS = frozenset({
    "PATH", "HOME", "TERM", "PS1", "DISPLAY", "WORKSPACE_ROOT",
    "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "LD_PRELOAD",
    "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONUNBUFFERED",
})


def _apply_vm_secrets(env: dict[str, str]) -> None:
    import json
    try:
        if not SECRETS_PATH.is_file():
            return
        data = json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(k, str) and isinstance(v, str) and k not in _RESERVED_ENV_KEYS:
                    env[k] = v
    except (OSError, ValueError, TypeError):
        pass


class FileToolError(Exception):
    """Base exception for file tool errors."""
    pass


class FileNotFoundInSandbox(FileToolError):
    pass


class PathTraversalError(FileToolError):
    pass


def _get_workspace_root(workspace_root: str | Path | None = None) -> Path:
    if workspace_root is not None:
        return Path(workspace_root).resolve()
    import sys
    mod = sys.modules.get("sandbox.services.file_tools")
    mod_root = getattr(mod, "WORKSPACE_ROOT", None) if mod else None
    root = mod_root or os.environ.get("WORKSPACE_ROOT") or WORKSPACE_ROOT
    return Path(root).resolve()


def _normalize_path(path: str, workspace_root: str | None = None) -> Path:
    """Normalize and validate a path is within workspace root."""
    workspace_root_obj = _get_workspace_root(workspace_root)

    path_str = str(path or "").strip()
    if os.path.isabs(path_str):
        # 1. If path is already inside workspace_root (e.g. /workspace/default/foo or /tmp/.../foo)
        try:
            cand = Path(path_str).resolve()
            if cand == workspace_root_obj or str(cand).startswith(str(workspace_root_obj) + "/"):
                return cand
        except Exception:
            pass

        raise PathTraversalError(f"Path {path} is outside workspace root {workspace_root_obj}; use that root or a relative path")
    else:
        cand = (workspace_root_obj / path_str).resolve()
        if cand != workspace_root_obj and not str(cand).startswith(str(workspace_root_obj) + "/"):
            raise PathTraversalError(f"Path {path} is outside workspace root")
        return cand


def file_read(path: str, offset: int = 0, limit: int = 10000) -> dict:
    """Read a file from the sandbox workspace."""
    path_obj = None
    try:
        cand = _normalize_path(path)
        if cand.exists() and cand.is_file():
            path_obj = cand
    except Exception:
        pass

    if path_obj is None:
        # Fallback to .uploads/ directory (e.g. if agent requests "filename.md" instead of ".uploads/filename.md")
        filename = Path(str(path or "").strip()).name
        if filename:
            uploads_cand = _get_workspace_root() / ".uploads" / filename
            if uploads_cand.exists() and uploads_cand.is_file():
                path_obj = uploads_cand
            else:
                raise FileNotFoundInSandbox(f"File not found: {path}")
        else:
            raise FileNotFoundInSandbox(f"File not found: {path}")

    with open(path_obj, "r", encoding="utf-8") as f:
        f.seek(offset)
        content = f.read(limit)

    root_obj = _get_workspace_root()
    return {
        "path": str(path_obj.relative_to(root_obj)),
        "content": content,
        "size": path_obj.stat().st_size,
        "mime": "text/plain",
    }


def file_write(path: str, content: str, mode: str = "w") -> dict:
    """Write content to a file in the sandbox workspace."""
    path_obj = _normalize_path(path)
    path_obj.parent.mkdir(parents=True, exist_ok=True)

    with open(path_obj, mode, encoding="utf-8") as f:
        f.write(content)

    root_obj = _get_workspace_root()
    return {
        "path": str(path_obj.relative_to(root_obj)),
        "bytes_written": len(content.encode("utf-8")),
        "mode": mode,
    }


def file_patch(path: str, find: str, replace: str, count: int = 1) -> dict:
    """Find and replace text in a file."""
    path_obj = _normalize_path(path)
    if not path_obj.exists() or not path_obj.is_file():
        raise FileNotFoundInSandbox(f"File not found: {path}")

    with open(path_obj, "r", encoding="utf-8") as f:
        content = f.read()

    if find not in content:
        raise FileToolError(f"Pattern not found in file: {find}")

    occurrences = content.count(find)
    if count > 0 and occurrences > count:
        raise FileToolError(f"Pattern occurs {occurrences} times, but count={count} requested")

    new_content = content.replace(find, replace, count if count > 0 else occurrences)

    with open(path_obj, "w", encoding="utf-8") as f:
        f.write(new_content)

    root_obj = _get_workspace_root()
    return {
        "path": str(path_obj.relative_to(root_obj)),
        "replacements": min(count, occurrences) if count > 0 else occurrences,
    }


def file_content_search(pattern: str, directory: str | None = None, recursive: bool = True) -> dict:
    """Search for pattern in files within workspace."""
    import re

    root_obj = _get_workspace_root()
    if directory is None:
        base_path = root_obj
    else:
        base_path = _normalize_path(directory)
    matches = []

    if recursive:
        for root, dirs, files in os.walk(base_path):
            for file in files:
                file_path = os.path.join(root, file)
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        content = f.read()
                        for line_num, line in enumerate(content.splitlines(), 1):
                            if pattern.lower() in line.lower() or re.search(pattern, line):
                                matches.append({
                                    "path": os.path.relpath(file_path, WORKSPACE_ROOT),
                                    "line": line_num,
                                    "line_content": line.strip()[:200],
                                })
                except (UnicodeDecodeError, PermissionError):
                    continue
    else:
        for file in os.listdir(base_path):
            file_path = base_path / file
            if file_path.is_file():
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        content = f.read()
                        for line_num, line in enumerate(content.splitlines(), 1):
                            if pattern.lower() in line.lower():
                                matches.append({
                                    "path": file,
                                    "line": line_num,
                                    "line_content": line.strip()[:200],
                                })
                except (UnicodeDecodeError, PermissionError):
                    continue

    return {
        "pattern": pattern,
        "matches": matches,
        "count": len(matches),
    }


@contextmanager
def _shell_script(command):
    # Keep command text out of process argv so pkill -f cannot match the shell
    # merely because a server name appears in the script being executed.
    fd, path = tempfile.mkstemp(prefix="nr-shell-", suffix=".sh")
    try:
        with os.fdopen(fd, "w") as script:
            script.write(command)
        yield path
    finally:
        os.unlink(path)


def shell_exec(command: str, cwd: str | None = None, timeout: int = 30, on_output=None) -> dict:
    """Execute a shell command in the sandbox."""
    import os

    root_obj = _get_workspace_root()
    if cwd is None:
        safe_cwd = root_obj
    else:
        safe_cwd = _normalize_path(cwd)

    if not safe_cwd.is_dir():
        return {
            "command": command,
            "exit_code": 1,
            "stdout": "",
            "stderr": f"Working directory not found: {safe_cwd}. Create the project directory with directory_create('.') or choose an existing cwd inside {root_obj}.",
            "cwd": str(safe_cwd),
            "workspace_root": str(root_obj),
        }

    try:
        rel_cwd = str(safe_cwd.relative_to(root_obj))
    except Exception:
        rel_cwd = "."

    try:
        if on_output is not None:
            return _stream_shell_process(command, safe_cwd, rel_cwd, timeout, on_output)
        env = os.environ.copy()
        _apply_vm_secrets(env)
        with _shell_script(command) as script:
            result = subprocess.run(
                ["/bin/bash", script], cwd=str(safe_cwd),
                capture_output=True, text=True, timeout=timeout, env=env,
            )
        return {
            "command": command,
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "cwd": rel_cwd,
        }
    except subprocess.TimeoutExpired:
        return {
            "command": command,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout} seconds",
            "cwd": rel_cwd,
        }
    except Exception as e:
        return {
            "command": command,
            "exit_code": -1,
            "stdout": "",
            "stderr": str(e),
            "cwd": rel_cwd,
        }


def _stream_shell_process(command, cwd, rel_cwd, timeout, on_output):
    with _shell_script(command) as script:
        return _stream_shell_script(script, command, cwd, rel_cwd, timeout, on_output)


def _stream_shell_script(script, command, cwd, rel_cwd, timeout, on_output):
    import codecs
    import selectors
    import signal
    import time

    output = {"stdout": [], "stderr": []}
    decoders = {name: codecs.getincrementaldecoder("utf-8")("replace") for name in output}
    env = os.environ.copy()
    _apply_vm_secrets(env)
    env["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(["/bin/bash", script], cwd=str(cwd),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                               env=env)
    deadline = time.monotonic() + timeout
    timed_out = False
    try:
        with selectors.DefaultSelector() as selector:
            for name in output:
                selector.register(getattr(process, name), selectors.EVENT_READ, name)
            while selector.get_map():
                if not timed_out and time.monotonic() >= deadline:
                    timed_out = True
                    os.killpg(process.pid, signal.SIGKILL)
                for key, _ in selector.select(0.1):
                    raw = os.read(key.fileobj.fileno(), 16384)
                    text = decoders[key.data].decode(raw, final=not raw)
                    if text:
                        output[key.data].append(text)
                        on_output(key.data, text)
                    if not raw:
                        selector.unregister(key.fileobj)
        exit_code = process.wait()
        if timed_out:
            text = f"\nCommand timed out after {timeout} seconds"
            output["stderr"].append(text)
            on_output("stderr", text)
        return {"command": command, "cwd": rel_cwd, "exit_code": -1 if timed_out else exit_code,
                **{name: "".join(chunks) for name, chunks in output.items()}}
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        process.stdout.close()
        process.stderr.close()


def list_directory(path: str | None = None, recursive: bool = False) -> dict:
    """List files in a directory."""
    root_obj = _get_workspace_root()
    if path is None:
        base_path = root_obj
        raw_path = str(root_obj)
    else:
        base_path = _normalize_path(path)
        raw_path = path

    if not base_path.exists() or not base_path.is_dir():
        raise FileNotFoundInSandbox(f"Directory not found: {raw_path}")

    items = []
    for item in os.listdir(base_path):
        item_path = base_path / item
        stat = item_path.stat()
        items.append({
            "name": item,
            "path": str(Path(raw_path) / item).lstrip("/"),
            "size": stat.st_size,
            "is_directory": item_path.is_dir(),
            "modified": stat.st_mtime,
        })

    return {
        "path": raw_path.lstrip("/"),
        "items": items,
        "count": len(items),
    }


def glob_files(pattern: str, directory: str | None = None) -> dict:
    """Find files matching a glob pattern."""
    root_obj = _get_workspace_root()
    if directory is None:
        base_path = root_obj
    else:
        base_path = _normalize_path(directory)
    matches = []

    for file_path in glob.glob(os.path.join(base_path, pattern), recursive=True):
        if os.path.isfile(file_path):
            stat = os.stat(file_path)
            matches.append({
                "path": os.path.relpath(file_path, root_obj),
                "size": stat.st_size,
                "modified": stat.st_mtime,
            })

    return {
        "pattern": pattern,
        "matches": matches,
        "count": len(matches),
    }


def http_request(
    method: str = "GET",
    url: str = "",
    headers: dict | None = None,
    body: dict | None = None,
    timeout: int = 10,
    **kwargs,
) -> dict:
    """Make an HTTP request from inside the sandbox."""
    import requests

    method = method.upper()
    if method not in ("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"):
        return {"error": f"Unsupported method: {method}"}

    try:
        resp = requests.request(
            method,
            url,
            headers=headers or {},
            json=body,
            timeout=timeout,
        )
        return {
            "status_code": resp.status_code,
            "headers": dict(resp.headers),
            "body": resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text[:10000],
        }
    except Exception as e:
        return {"error": str(e)}


import html
from html.parser import HTMLParser


class HTMLToTextParser(HTMLParser):
    """Zero-dependency HTML to clean plain text parser using standard library."""
    def __init__(self):
        super().__init__()
        self.text_parts = []
        self.ignore_depth = 0
        self.ignore_tags = {"script", "style", "head", "title", "svg", "nav", "footer", "aside"}
        self.current_tag = None

    def handle_starttag(self, tag, attrs):
        self.current_tag = tag.lower()
        if self.current_tag in self.ignore_tags:
            self.ignore_depth += 1
        if self.current_tag in {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "br"}:
            self.text_parts.append("\n")

    def handle_endtag(self, tag):
        tag_lower = tag.lower()
        if tag_lower in self.ignore_tags:
            self.ignore_depth = max(0, self.ignore_depth - 1)
        if tag_lower in {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"}:
            self.text_parts.append("\n")

    def handle_data(self, data):
        if self.ignore_depth == 0:
            cleaned = data.strip()
            if cleaned:
                self.text_parts.append(html.unescape(cleaned) + " ")

    def get_text(self) -> str:
        raw = "".join(self.text_parts)
        lines = [line.strip() for line in raw.split("\n")]
        non_empty_lines = []
        for line in lines:
            if line:
                non_empty_lines.append(line)
            elif not non_empty_lines or non_empty_lines[-1] != "":
                non_empty_lines.append("")
        return "\n".join(non_empty_lines).strip()




def file_delete(path: str) -> dict:
    """Delete a file or directory in the sandbox workspace."""
    path_obj = _normalize_path(path)
    if not path_obj.exists():
        raise FileNotFoundInSandbox(f"Path not found: {path}")

    if path_obj.is_dir():
        import shutil
        shutil.rmtree(path_obj)
        deleted_type = "directory"
    else:
        path_obj.unlink()
        deleted_type = "file"

    return {
        "path": path,
        "success": True,
        "type": deleted_type,
    }


def file_rename(old_path: str, new_path: str) -> dict:
    """Rename or move a file or directory in the sandbox workspace."""
    old_obj = _normalize_path(old_path)
    new_obj = _normalize_path(new_path)

    if not old_obj.exists():
        raise FileNotFoundInSandbox(f"Source path not found: {old_path}")

    # Ensure parent of destination exists
    new_obj.parent.mkdir(parents=True, exist_ok=True)

    import shutil
    destination = new_obj / old_obj.name if new_obj.is_dir() else new_obj
    if destination == old_obj:
        return {"old_path": old_path, "new_path": new_path, "success": True}
    if old_obj.is_dir() and destination.is_relative_to(old_obj):
        raise FileToolError("Cannot move a directory into itself")
    try:
        os.rename(old_obj, destination)
    except OSError as exc:
        if exc.errno not in {errno.ENOSYS, errno.EXDEV, errno.EOPNOTSUPP}:
            raise
        # copy2/copystat also fail on object-storage mounts. Copy bytes only and
        # delete the source only after the entire copy has completed.
        if old_obj.is_dir():
            def copy_directory(source, target):
                target.mkdir()
                for entry in source.iterdir():
                    if entry.is_symlink():
                        raise FileToolError("Moving directories with symbolic links is unsupported on this storage mount")
                    if entry.is_dir():
                        copy_directory(entry, target / entry.name)
                    else:
                        shutil.copyfile(entry, target / entry.name)
            copy_directory(old_obj, destination)
            def remove_directory(path):
                for entry in path.iterdir():
                    if entry.is_dir() and not entry.is_symlink():
                        remove_directory(entry)
                    else:
                        entry.unlink()
                try:
                    path.rmdir()
                except OSError as error:
                    if error.errno == errno.ENOENT:
                        return
                    if error.errno not in {errno.ENOSYS, errno.EOPNOTSUPP, errno.EPERM} or any(path.iterdir()):
                        raise
            remove_directory(old_obj)
        else:
            shutil.copyfile(old_obj, destination)
            old_obj.unlink()

    return {
        "old_path": old_path,
        "new_path": new_path,
        "success": True,
    }


def directory_create(path: str) -> dict:
    """Create a directory in the sandbox workspace."""
    path_obj = _normalize_path(path)
    path_obj.mkdir(parents=True, exist_ok=True)

    return {
        "path": path,
        "success": True,
    }


# ─── Desktop Control (KDE Plasma on DISPLAY :1 + PulseAudio nr_speaker) ───────

DESKTOP_STATE_DIR = Path("/var/lib/neuronrunner")
DESKTOP_SUPERVISOR_PATH = DESKTOP_STATE_DIR / "neuronrunner_desktop.py"
DESKTOP_RECORDING_PATH = DESKTOP_STATE_DIR / "desktop-recording.json"
DESKTOP_RUNTIME_DIR = Path("/tmp/neuronrunner-desktop-runtime")
DESKTOP_AUDIO_SINK = "nr_speaker"


def _desktop_env() -> dict[str, str]:
    DESKTOP_RUNTIME_DIR.mkdir(mode=0o700, exist_ok=True)
    DESKTOP_RUNTIME_DIR.chmod(0o700)
    env = {
        **os.environ,
        "DISPLAY": ":1",
        "XDG_RUNTIME_DIR": str(DESKTOP_RUNTIME_DIR),
        "HOME": str(Path.home()),
        "PULSE_SINK": DESKTOP_AUDIO_SINK,
        "PULSE_LATENCY_MSEC": "30",
    }
    env.pop("PULSE_SERVER", None)
    return env


def _ensure_desktop_packages() -> None:
    import shutil

    needed = ("xdotool", "scrot", "xclip", "xwininfo", "ffmpeg")
    if all(shutil.which(cmd) for cmd in needed):
        return
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    subprocess.run(["apt-get", "-o", "DPkg::Lock::Timeout=120", "update"], env=env, capture_output=True, timeout=180, check=False)
    subprocess.run(
        ["apt-get", "-o", "DPkg::Lock::Timeout=120", "install", "-y", "--no-install-recommends",
         "xdotool", "scrot", "xclip", "x11-utils", "ffmpeg", "pulseaudio", "pulseaudio-utils"],
        env=env, capture_output=True, timeout=300, check=False,
    )


def _ensure_desktop_audio(env: dict[str, str]) -> bool:
    import shutil

    if not shutil.which("pulseaudio") or not shutil.which("pactl"):
        return False
    try:
        if subprocess.run(["pactl", "info"], env=env, capture_output=True, timeout=3).returncode != 0:
            subprocess.run(["pulseaudio", "--start", "--exit-idle-time=-1", "--disallow-exit"],
                           env=env, capture_output=True, timeout=6, check=False)
        sinks = subprocess.run(["pactl", "list", "short", "sinks"], env=env, capture_output=True, text=True, timeout=3)
        if DESKTOP_AUDIO_SINK not in (sinks.stdout or ""):
            subprocess.run(["pactl", "load-module", "module-null-sink", f"sink_name={DESKTOP_AUDIO_SINK}",
                            "sink_properties=device.description=NeuronRunner_Speaker"],
                           env=env, capture_output=True, timeout=4, check=False)
        subprocess.run(["pactl", "set-default-sink", DESKTOP_AUDIO_SINK], env=env, capture_output=True, timeout=3, check=False)
        return True
    except Exception:
        return False


def _desktop_screen_size(env: dict[str, str]) -> tuple[int, int]:
    import re

    res = subprocess.run(["xwininfo", "-root"], env=env, capture_output=True, text=True, timeout=5)
    if res.returncode != 0:
        raise FileToolError(f"Desktop display :1 is not responding: {res.stderr.strip()}")
    match = re.search(r"Width:\s+(\d+)\s+Height:\s+(\d+)", res.stdout)
    if not match:
        raise FileToolError("Unable to read desktop geometry from xwininfo")
    return int(match.group(1)), int(match.group(2))


def _ensure_desktop_ready() -> dict[str, str]:
    import sys
    import time

    _ensure_desktop_packages()
    env = _desktop_env()
    probe = subprocess.run(["xwininfo", "-root"], env=env, capture_output=True, timeout=3)
    if probe.returncode != 0:
        if DESKTOP_SUPERVISOR_PATH.is_file():
            subprocess.run([sys.executable, str(DESKTOP_SUPERVISOR_PATH), "--ensure"],
                           capture_output=True, timeout=20, check=False)
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            if subprocess.run(["xwininfo", "-root"], env=env, capture_output=True, timeout=2).returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise FileToolError("Desktop display :1 could not be started. Open the Desktop tab or check the VM status.")
    _ensure_desktop_audio(env)
    return env


def _capture_desktop_screenshot(env: dict[str, str], save_path: str | None = None) -> dict:
    import base64

    width, height = _desktop_screen_size(env)
    if save_path:
        target = _normalize_path(save_path)
    else:
        target = Path("/workspace/.neuronrunner/desktop-latest.png")
    target.parent.mkdir(parents=True, exist_ok=True)
    res = subprocess.run(["scrot", "--overwrite", str(target)], env=env, capture_output=True, text=True, timeout=10)
    if res.returncode != 0 or not target.is_file():
        raise FileToolError(f"Failed to capture desktop screenshot: {res.stderr.strip()}")
    raw = target.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    return {
        "width": width,
        "height": height,
        "path": str(target),
        "source": str(target),
        "mime": "image/png",
        "size_bytes": len(raw),
        "image_url": f"data:image/png;base64,{b64}",
    }


def _run_xdotool(env: dict[str, str], *args: str) -> None:
    res = subprocess.run(["xdotool", *args], env=env, capture_output=True, text=True, timeout=10)
    if res.returncode != 0:
        raise FileToolError(f"xdotool failed: {res.stderr.strip() or res.stdout.strip()}")


def desktop_control(
    action: str,
    x: int | None = None,
    y: int | None = None,
    to_x: int | None = None,
    to_y: int | None = None,
    button: str = "left",
    count: int = 1,
    direction: str = "down",
    amount: int = 3,
    key: str | None = None,
    keys: list[str] | None = None,
    text: str | None = None,
    press_enter: bool = False,
    command: str | list[str] | None = None,
    width: int | None = None,
    height: int | None = None,
    path: str | None = None,
    fps: int = 30,
    wait_ms: int | None = None,
    include_screenshot: bool | None = None,
    **kwargs,
) -> dict:
    """Control the live KDE desktop on DISPLAY :1 and return visual feedback."""
    import json
    import shlex
    import signal
    import time

    action = (action or "").strip().lower()
    valid_actions = {
        "screenshot", "screen_size", "move_mouse", "click",
        "double_click", "right_click", "drag", "scroll", "press",
        "write", "launch", "wait", "start_recording", "stop_recording",
    }
    if action not in valid_actions:
        return {"error": f"Unsupported desktop action '{action}'. Choose from: {', '.join(sorted(valid_actions))}."}

    env = _ensure_desktop_ready()

    if action == "screen_size":
        w, h = _desktop_screen_size(env)
        result = {"status": "ok", "action": action, "width": w, "height": h}
        if include_screenshot:
            result.update(_capture_desktop_screenshot(env, path))
        return result

    if action == "screenshot":
        snap = _capture_desktop_screenshot(env, path)
        return {
            "status": "ok",
            "action": action,
            **snap,
            "message": "Desktop screenshot captured and attached to your visual context.",
        }

    if action == "move_mouse":
        if x is None or y is None:
            return {"error": "move_mouse requires both x and y pixel coordinates."}
        _run_xdotool(env, "mousemove", str(int(x)), str(int(y)))

    elif action in {"click", "double_click", "right_click"}:
        if action == "double_click":
            button, count = "left", 2
        elif action == "right_click":
            button, count = "right", 1
        buttons = {"left": "1", "middle": "2", "right": "3"}
        if button not in buttons or not (1 <= int(count) <= 3):
            return {"error": "Use button='left'|'middle'|'right' and count between 1 and 3."}
        if (x is None) != (y is None):
            return {"error": "Provide both x and y coordinates, or omit both to click at current cursor."}
        cmd = []
        if x is not None and y is not None:
            cmd.extend(["mousemove", str(int(x)), str(int(y))])
        cmd.extend(["click", "--repeat", str(int(count)), "--delay", "100", buttons[button]])
        _run_xdotool(env, *cmd)

    elif action == "drag":
        if None in (x, y, to_x, to_y):
            return {"error": "drag requires x, y, to_x, and to_y coordinates."}
        _run_xdotool(
            env,
            "mousemove", str(int(x)), str(int(y)),
            "mousedown", "1",
            "mousemove", str(int(to_x)), str(int(to_y)),
            "mouseup", "1",
        )

    elif action == "scroll":
        buttons = {"up": "4", "down": "5", "left": "6", "right": "7"}
        if direction not in buttons or not (1 <= int(amount) <= 100):
            return {"error": "scroll requires direction in ('up','down','left','right') and amount 1-100."}
        cmd = []
        if x is not None and y is not None:
            cmd.extend(["mousemove", str(int(x)), str(int(y))])
        cmd.extend(["click", "--repeat", str(int(amount)), buttons[direction]])
        _run_xdotool(env, *cmd)

    elif action == "press":
        seq = list(keys) if isinstance(keys, list) and keys else ([key] if isinstance(key, str) and key.strip() else [])
        if not seq or any(not isinstance(k, str) or not k.strip() or k.strip().startswith("-") for k in seq):
            return {"error": "press requires key (e.g. 'Return', 'ctrl+l', 'alt+Tab') or keys array."}
        _run_xdotool(env, "key", "--clearmodifiers", *[k.strip() for k in seq])

    elif action == "write":
        if text is None or not isinstance(text, str):
            return {"error": "write requires a text string."}
        clip = subprocess.run(["xclip", "-selection", "clipboard", "-in"], input=text, text=True, env=env, capture_output=True, timeout=5)
        if clip.returncode == 0:
            _run_xdotool(env, "key", "--clearmodifiers", "ctrl+v")
        else:
            _run_xdotool(env, "type", "--clearmodifiers", "--delay", "10", "--", text)
        if press_enter:
            time.sleep(0.08)
            _run_xdotool(env, "key", "--clearmodifiers", "Return")

    elif action == "launch":
        if not command:
            return {"error": "launch requires a command string or argv list (e.g. 'chromium https://example.com')."}
        argv = shlex.split(command) if isinstance(command, str) else [str(part) for part in command]
        if not argv:
            return {"error": "launch requires a non-empty command."}
        if argv[0] in {"chromium", "chromium-browser", "google-chrome"} and "--no-sandbox" not in argv:
            argv = [argv[0], "--no-sandbox", "--test-type", "--disable-dev-shm-usage", "--password-store=basic", *argv[1:]]
        cwd = str(_get_workspace_root())
        proc = subprocess.Popen(
            argv,
            cwd=cwd if Path(cwd).is_dir() else "/workspace",
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        delay = (wait_ms if wait_ms is not None else 1200) / 1000.0
        time.sleep(max(0.1, min(15.0, delay)))
        result = {"status": "ok", "action": action, "pid": proc.pid, "command": argv}
        if include_screenshot is not False:
            snap = _capture_desktop_screenshot(env, path)
            result.update(snap)
            result["message"] = f"Launched {' '.join(argv)} (PID {proc.pid}). Screenshot attached to visual context."
        return result

    elif action == "wait":
        delay = (wait_ms if wait_ms is not None else 1000) / 1000.0
        time.sleep(max(0.1, min(15.0, delay)))

    elif action == "start_recording":
        fps = int(fps or 30)
        if not (1 <= fps <= 60):
            return {"error": "Recording fps must be between 1 and 60."}
        if DESKTOP_RECORDING_PATH.is_file():
            try:
                existing = json.loads(DESKTOP_RECORDING_PATH.read_text())
                old_pid = int(existing.get("pid", 0))
                if old_pid > 0 and Path(f"/proc/{old_pid}").exists():
                    return {"error": f"A desktop recording is already active (PID {old_pid}, path {existing.get('path')}). Stop it first with action='stop_recording'."}
            except Exception:
                pass
            DESKTOP_RECORDING_PATH.unlink(missing_ok=True)
        out_path = _normalize_path(path or f"desktop-recording-{int(time.time())}.mp4")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.unlink(missing_ok=True)
        w, h = _desktop_screen_size(env)
        has_audio = _ensure_desktop_audio(env)
        ffmpeg_cmd = [
            "ffmpeg", "-nostdin", "-y",
            "-f", "x11grab", "-video_size", f"{w}x{h}", "-framerate", str(fps), "-i", ":1",
        ]
        if has_audio:
            ffmpeg_cmd.extend(["-f", "pulse", "-i", f"{DESKTOP_AUDIO_SINK}.monitor"])
        ffmpeg_cmd.extend([
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", str(fps),
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        ])
        if has_audio:
            ffmpeg_cmd.extend(["-c:a", "aac", "-b:a", "128k"])
        ffmpeg_cmd.extend(["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", str(out_path)])
        proc = subprocess.Popen(
            ffmpeg_cmd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        time.sleep(0.3)
        if proc.poll() is not None and has_audio:
            # Fallback to video-only if pulse input fails in constrained container
            has_audio = False
            ffmpeg_cmd = [
                "ffmpeg", "-nostdin", "-y",
                "-f", "x11grab", "-video_size", f"{w}x{h}", "-framerate", str(fps), "-i", ":1",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", str(fps),
                "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", str(out_path),
            ]
            proc = subprocess.Popen(
                ffmpeg_cmd, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            )
            time.sleep(0.2)
        if proc.poll() is not None:
            return {"error": "ffmpeg exited immediately when starting desktop screen recording."}
        DESKTOP_STATE_DIR.mkdir(parents=True, exist_ok=True)
        rec_meta = {"pid": proc.pid, "path": str(out_path), "fps": fps, "audio": has_audio, "started_at": time.time()}
        DESKTOP_RECORDING_PATH.write_text(json.dumps(rec_meta))
        return {
            "status": "ok",
            "action": action,
            **rec_meta,
            "message": f"Desktop screen recording started ({w}x{h} @ {fps}fps, audio={'enabled' if has_audio else 'disabled'}) -> {out_path}",
        }

    elif action == "stop_recording":
        if not DESKTOP_RECORDING_PATH.is_file():
            return {"error": "No active desktop recording found."}
        rec_meta = json.loads(DESKTOP_RECORDING_PATH.read_text())
        pid = int(rec_meta.get("pid", 0))
        rec_path = Path(rec_meta.get("path", ""))
        if pid > 0 and Path(f"/proc/{pid}").exists():
            try:
                os.kill(pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline and Path(f"/proc/{pid}").exists():
                time.sleep(0.1)
            if Path(f"/proc/{pid}").exists():
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        DESKTOP_RECORDING_PATH.unlink(missing_ok=True)
        size_bytes = rec_path.stat().st_size if rec_path.is_file() else 0
        result = {
            "status": "ok",
            "action": action,
            "path": str(rec_path),
            "size_bytes": size_bytes,
            "audio": rec_meta.get("audio", False),
            "message": f"Desktop recording saved to {rec_path} ({size_bytes} bytes).",
        }
        if include_screenshot:
            result.update(_capture_desktop_screenshot(env))
        return result

    if include_screenshot is not False:
        delay = (wait_ms if wait_ms is not None else 350) / 1000.0
        if delay > 0 and action != "wait":
            time.sleep(max(0.05, min(10.0, delay)))
        snap = _capture_desktop_screenshot(env, path)
        return {
            "status": "ok",
            "action": action,
            **snap,
            "message": f"Desktop action '{action}' completed. The updated desktop screenshot ({snap['width']}x{snap['height']}) is attached to your visual context.",
        }

    w, h = _desktop_screen_size(env)
    return {"status": "ok", "action": action, "width": w, "height": h}


# ─── Dispatcher ───────────────────────────────────────────────────────────────

TOOL_HANDLERS = {
    "file_read": file_read,
    "file_write": file_write,
    "file_patch": file_patch,
    "file_content_search": file_content_search,
    "shell_exec": shell_exec,
    "list_directory": list_directory,
    "glob_files": glob_files,
    "http_request": http_request,
    "file_delete": file_delete,
    "file_rename": file_rename,
    "directory_create": directory_create,
    "desktop": desktop_control,
}


def dispatch_file_tool(tool_name: str, arguments: dict) -> dict:
    """Dispatch a file tool call to the appropriate handler."""
    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        return {"error": f"Unknown tool: {tool_name}"}

    # Filter out metadata arguments starting with an underscore
    clean_args = {k: v for k, v in arguments.items() if not k.startswith("_")}

    try:
        return handler(**clean_args)
    except FileNotFoundInSandbox as e:
        return {"error": f"File not found: {e}"}
    except Exception as e:
        logger.exception(f"Tool {tool_name} failed: {e}")
        return {"error": str(e)}
