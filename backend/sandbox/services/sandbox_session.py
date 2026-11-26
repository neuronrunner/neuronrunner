"""Sandbox session management — isolated local Docker containers per workspace.

Projects in the same team workspace share a Docker container and persistent
filesystem mount; each project selects its own directory inside /workspace.
"""
from __future__ import annotations

import base64
import contextvars
import json
import logging
import shlex
import subprocess
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime as dt, timezone as dt_timezone
from pathlib import Path
from typing import Any

from django.db import transaction
from django.utils import timezone

from sandbox.models import Sandbox
from sandbox.services.docker_sandbox import (
    DEFAULT_RUNTIME_NAME,
    DockerSandboxError,
    LocalDockerSandbox,
    count_running_runtimes,
    get_sandbox_container_name,
    is_default_runtime,
    list_running_named_runtimes,
    list_workspace_runtimes,
    normalize_runtime_name,
    remove_docker_runtime,
    stop_docker_runtime,
    workspace_id_from_container,
)
from utils.cache import (
    delete_cache,
    clear_sandbox_status,
    get_all_sandbox_status,
    get_cache,
    set_cache,
    set_sandbox_files,
    set_sandbox_status,
)

logger = logging.getLogger(__name__)

# Runtime chosen for the current request (the ``X-Sandbox-Runtime`` header or the
# terminal's ``vm_uuid`` query parameter). Empty means the workspace's default runtime.
_selected_runtime: contextvars.ContextVar[str | None] = contextvars.ContextVar("nr_selected_runtime", default=None)


class RuntimeLimitError(DockerSandboxError):
    """The workspace already runs as many sandboxes as it is allowed to."""


def coerce_runtime_name(value) -> str | None:
    """Return a valid named runtime, or None for the default runtime and unusable values.

    Only the local Docker provider has named runtimes; with a remote provider (such
    as a cloud VM uuid sent by the cloud edition) this always returns None.
    """
    from sandbox.services.runtime_provider import uses_docker

    if not value or not uses_docker():
        return None
    try:
        name = normalize_runtime_name(value)
    except ValueError:
        return None
    return None if is_default_runtime(name) else name


def selected_runtime() -> str | None:
    return _selected_runtime.get()


@contextmanager
def use_runtime(value):
    """Route sandbox calls made inside the block to the given named runtime."""
    token = _selected_runtime.set(coerce_runtime_name(value))
    try:
        yield
    finally:
        _selected_runtime.reset(token)


def max_concurrent_runtimes(workspace) -> int | None:
    """Running-sandbox cap per workspace from the plan policy; None means unlimited."""
    from core.extensions import registry as ext_registry

    try:
        policy = ext_registry.quota.resolve_plan_policy(workspace) or {}
    except Exception:
        logger.warning("Could not resolve plan policy for runtime limit", exc_info=True)
        policy = {}
    value = policy.get("max_concurrent_vms")
    if value is None:
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _audit_runtime_id(sandbox, project) -> str:
    runtime_name = getattr(sandbox, "runtime_name", None)
    container = getattr(sandbox, "container_name", None)
    if isinstance(runtime_name, str) and not is_default_runtime(runtime_name) and isinstance(container, str):
        return container
    return getattr(project, "sandbox_object_id", "") or ""


def _runtime_activity_key(container: str) -> str:
    return f"runtime_activity:{container}"


def _session_key(project: "Sandbox") -> str:
    """A team workspace owns one runtime; projects select directories inside it."""
    return f"workspace:{project.workspace_id or f'user-{project.user_id}'}"


def _workspace_projects(project):
    if project.workspace_id:
        return Sandbox.objects.filter(workspace_id=project.workspace_id)
    return Sandbox.objects.filter(user_id=project.user_id, workspace__isnull=True)


@contextmanager
def _runtime_lock(project):
    """Serialize runtime creation/release across application workers."""
    from django.contrib.auth import get_user_model
    from sandbox.models import Workspace

    with transaction.atomic():
        if project.workspace_id:
            Workspace.objects.select_for_update().get(pk=project.workspace_id)
        else:
            get_user_model().objects.select_for_update().get(pk=project.user_id)
        project.refresh_from_db()
        shared = _workspace_projects(project).exclude(sandbox_object_id="").order_by("created_at").first()
        if shared and shared.uuid != project.uuid:
            project.sandbox_object_id = shared.sandbox_object_id
            Sandbox.objects.filter(pk=project.pk).update(
                sandbox_object_id=shared.sandbox_object_id,
            )
        yield


@dataclass
class SandboxHandle:
    """Wrapper for a workspace Docker sandbox instance with metadata."""
    sandbox: Any
    project: "Sandbox"
    gpu: str
    created_at: float
    last_active: float
    initial_commands: list[str] = field(default_factory=list)

    @property
    def object_id(self) -> str:
        obj_id = getattr(self.sandbox, "object_id", None)
        if isinstance(obj_id, str) and obj_id:
            return obj_id
        container_name = getattr(self.sandbox, "container_name", None)
        if isinstance(container_name, str) and container_name:
            return container_name
        return ""


class SandboxSessionManager:
    """Manages one Docker container runtime per workspace across projects and workers."""

    def __init__(self):
        self._sessions: dict[str, SandboxHandle] = {}
        self._session_commands: dict[str, list] = {}
        self._lock = threading.Lock()

    def _record_activity(self, handle: SandboxHandle) -> dict:
        now = time.time()
        handle.last_active = now
        idle_timeout = self._get_idle_window(handle.project)
        shutdown_at = now + idle_timeout
        status_data = {
            "object_id": handle.object_id,
            "last_active": now,
            "idle_timeout": idle_timeout,
            "shutdown_at": shutdown_at,
            "remaining_seconds": idle_timeout,
            "is_alive": True,
        }
        set_sandbox_status(str(handle.project.uuid), status_data)
        try:
            _workspace_projects(handle.project).update(sandbox_last_active_at=timezone.now())
        except Exception as exc:
            logger.warning("Failed to update sandbox_last_active_at in DB: %s", exc)
        return status_data

    def update_activity(self, project_uuid: str, runtime: str | None = None) -> dict:
        """Refresh workspace activity timestamp under the shared runtime lock."""
        project = Sandbox.objects.filter(uuid=project_uuid).first()
        if not project:
            return {}
        runtime_name = coerce_runtime_name(runtime) if runtime is not None else selected_runtime()
        if runtime_name:
            container = get_sandbox_container_name(project, runtime_name)
            self._touch_named(container)
            now = time.time()
            idle_timeout = self._get_idle_window(project)
            return {
                "object_id": container,
                "last_active": now,
                "idle_timeout": idle_timeout,
                "shutdown_at": now + idle_timeout,
                "remaining_seconds": idle_timeout,
                "is_alive": True,
            }
        with self._lock, _runtime_lock(project):
            handle = self._sessions.get(_session_key(project))
            if handle and handle.object_id == project.sandbox_object_id:
                handle.project = project
                return self._record_activity(handle)
            alive = bool(project.sandbox_object_id)
            now = time.time()
            idle_timeout = self._get_idle_window(project)
            status_data = {
                "object_id": project.sandbox_object_id,
                "last_active": now,
                "idle_timeout": idle_timeout,
                "shutdown_at": now + idle_timeout if alive else None,
                "remaining_seconds": idle_timeout if alive else 0,
                "is_alive": alive,
            }
            set_sandbox_status(project_uuid, status_data)
            if alive:
                _workspace_projects(project).update(sandbox_last_active_at=timezone.now())
            return status_data

    def record_terminal_command(self, project: "Sandbox", cmd: str) -> None:
        proj_key = _session_key(project)
        with self._lock:
            self._session_commands.setdefault(proj_key, []).append(cmd[:200])

    def close_session_immediately(self, project: "Sandbox") -> None:
        with self._lock, _runtime_lock(project):
            self._release_workspace(project)

    def _release_workspace(self, project):
        from core.extensions import registry as ext_registry
        from sandbox.services.runtime_provider import connect_runtime, is_remote_runtime_id

        handle = self._sessions.get(_session_key(project))
        if handle and handle.object_id == project.sandbox_object_id:
            self._terminate_session(handle)
        else:
            if project.sandbox_object_id:
                if is_remote_runtime_id(project.sandbox_object_id):
                    try:
                        runtime = connect_runtime(project.sandbox_object_id)
                        try:
                            runtime.terminate()
                        finally:
                            runtime.close()
                    except Exception as exc:
                        logger.warning("Could not stop remote runtime %s: %s", project.sandbox_object_id, exc)
                else:
                    try:
                        subprocess.run(["docker", "stop", "-t", "2", project.sandbox_object_id], capture_output=True)
                    except Exception as exc:
                        logger.warning("Could not stop container %s: %s", project.sandbox_object_id, exc)
            self._clear_workspace_runtime(project)

    def _clear_workspace_runtime(self, project):
        from sandbox.services.runtime_provider import is_remote_runtime_id

        projects = _workspace_projects(project)
        for project_uuid in projects.values_list("uuid", flat=True):
            clear_sandbox_status(str(project_uuid))
        kept_id = project.sandbox_object_id if is_remote_runtime_id(project.sandbox_object_id) else ""
        projects.update(sandbox_object_id=kept_id, terminal_url="", terminal_token="", sandbox_last_active_at=None)
        self._sessions.pop(_session_key(project), None)
        self._session_commands.pop(_session_key(project), None)
        project.sandbox_object_id = kept_id
        project.terminal_url = ""
        project.terminal_token = ""

    def cleanup_all_idle(self) -> None:
        """Stop idle workspace containers whose inactivity window has elapsed."""
        from sandbox.services.runtime_provider import is_remote_runtime_id

        candidates = set(get_all_sandbox_status())
        runtimes = Sandbox.objects.exclude(sandbox_object_id="")
        candidates.update(str(pk) for pk in runtimes.values_list("uuid", flat=True))
        checked = set()
        for project_uuid in candidates:
            project = Sandbox.objects.filter(uuid=project_uuid).first()
            if not project:
                clear_sandbox_status(project_uuid)
                continue
            if is_remote_runtime_id(project.sandbox_object_id):
                continue
            key = _session_key(project)
            if key in checked:
                continue
            checked.add(key)
            try:
                with self._lock, _runtime_lock(project):
                    last_active = (
                        _workspace_projects(project)
                        .order_by("-sandbox_last_active_at")
                        .values_list("sandbox_last_active_at", flat=True)
                        .first()
                    )
                    if last_active and (timezone.now() - last_active).total_seconds() < self._get_idle_window(project):
                        continue
                    self._release_workspace(project)
            except Exception as exc:
                logger.warning("Could not release idle workspace %s: %s", key, exc)

        from sandbox.services.runtime_provider import uses_docker
        if uses_docker():
            self._cleanup_idle_named()

    def _get_idle_window(self, project) -> int:
        return getattr(project, "idle_timeout_seconds", 1800) or 1800

    def _create_sandbox(self, project: "Sandbox", region: str | None = None) -> Any:
        """Start or attach to the workspace's configured sandbox runtime."""
        from sandbox.services.runtime_provider import create_remote_runtime, uses_remote_runtime

        if uses_remote_runtime():
            runtime = create_remote_runtime(project)
        else:
            runtime = LocalDockerSandbox(project)
        _workspace_projects(project).update(
            sandbox_object_id=runtime.object_id,
            terminal_url="",
            terminal_token="",
        )
        project.sandbox_object_id = runtime.object_id
        project.terminal_url = ""
        project.terminal_token = ""
        return runtime

    def get_or_create(self, project: "Sandbox", region: str | None = None, runtime: str | None = None) -> Any:
        """Get the active sandbox runtime for the workspace, or start it.

        ``runtime`` (or the runtime selected for the current request) picks one of
        the workspace's named local Docker runtimes; without one this is the
        workspace's default runtime.
        """
        from core.extensions import registry as ext_registry
        from sandbox.services.runtime_provider import connect_runtime, is_remote_runtime_id

        runtime_name = coerce_runtime_name(runtime) if runtime is not None else selected_runtime()
        if runtime_name:
            return self._get_or_create_named(project, runtime_name)

        with self._lock, _runtime_lock(project):
            session_key = _session_key(project)
            handle = self._sessions.get(session_key)
            if handle is not None:
                if handle.object_id != project.sandbox_object_id and project.sandbox_object_id:
                    self._sessions.pop(session_key, None)
                    handle = None
                else:
                    try:
                        if handle.sandbox.poll() is None:
                            handle.project = project
                            self._record_activity(handle)
                            ext_registry.runtime.touch_active_runtime(handle.object_id)
                            return handle.sandbox
                    except Exception:
                        pass
                    self._sessions.pop(session_key, None)

            sandbox = None
            if project.sandbox_object_id and is_remote_runtime_id(project.sandbox_object_id):
                try:
                    candidate = connect_runtime(project.sandbox_object_id, start=False)
                    if candidate.poll() is None:
                        sandbox = candidate
                except Exception:
                    sandbox = None

            if sandbox is None:
                sandbox = self._create_sandbox(project, region=region)
            now = time.time()
            handle = SandboxHandle(
                sandbox=sandbox,
                project=project,
                gpu=project.sandbox_gpu or "CPU",
                created_at=now,
                last_active=now,
            )
            self._sessions[session_key] = handle
            self._record_activity(handle)
            ext_registry.runtime.touch_active_runtime(handle.object_id)
            return sandbox

    # ─── Named local runtimes ─────────────────────────────────────────────

    def _named_key(self, project, runtime_name: str) -> str:
        return f"{_session_key(project)}#{runtime_name}"

    def _touch_named(self, container: str) -> None:
        set_cache(_runtime_activity_key(container), time.time(), timeout=7 * 86400)

    def _enforce_runtime_limit(self, project, runtime_name: str) -> None:
        limit = max_concurrent_runtimes(getattr(project, "workspace", None))
        if limit is None:
            return
        running = count_running_runtimes(project, exclude=runtime_name)
        if running >= limit:
            raise RuntimeLimitError(
                f"This workspace already runs {running} sandbox(es), the maximum is {limit}. "
                "Stop a runtime first or raise DOCKER_SANDBOX_MAX_CONCURRENT."
            )

    def _get_or_create_named(self, project, runtime_name: str) -> Any:
        key = self._named_key(project, runtime_name)
        with self._lock:
            handle = self._sessions.get(key)
            if handle is not None:
                try:
                    if handle.sandbox.poll() is None:
                        handle.project = project
                        handle.last_active = time.time()
                        self._touch_named(handle.object_id)
                        return handle.sandbox
                except Exception:
                    pass
                self._sessions.pop(key, None)

        # Hold the workspace lock while counting and starting so two launches
        # cannot both pass the limit check.
        with transaction.atomic():
            if project.workspace_id:
                from sandbox.models import Workspace
                Workspace.objects.select_for_update().get(pk=project.workspace_id)
            self._enforce_runtime_limit(project, runtime_name)
            sandbox = LocalDockerSandbox(project, runtime_name=runtime_name)

        now = time.time()
        with self._lock:
            self._sessions[key] = SandboxHandle(
                sandbox=sandbox,
                project=project,
                gpu=project.sandbox_gpu or "CPU",
                created_at=now,
                last_active=now,
            )
        self._touch_named(sandbox.object_id)
        return sandbox

    def list_runtimes(self, project) -> list[dict]:
        """Describe the workspace's local Docker runtimes for the UI."""
        items = list_workspace_runtimes(project)
        for item in items:
            last_active = get_cache(_runtime_activity_key(item["container"]))
            if item["is_default"] and project.sandbox_last_active_at:
                last_active = project.sandbox_last_active_at.timestamp()
            item["last_active"] = last_active
        return items

    def start_runtime(self, project, runtime_name: str | None) -> Any:
        name = normalize_runtime_name(runtime_name)
        if is_default_runtime(name):
            return self.get_or_create(project, runtime=DEFAULT_RUNTIME_NAME)
        return self._get_or_create_named(project, name)

    def stop_runtime(self, project, runtime_name: str | None, *, remove: bool = False) -> None:
        """Stop (or, for a named runtime, delete) one runtime container."""
        name = normalize_runtime_name(runtime_name)
        if is_default_runtime(name):
            if remove:
                raise DockerSandboxError("The default runtime cannot be removed; stop it instead.")
            self.close_session_immediately(project)
            return
        with self._lock:
            self._sessions.pop(self._named_key(project, name), None)
        if remove:
            remove_docker_runtime(project, name)
        else:
            stop_docker_runtime(project, name)
        delete_cache(_runtime_activity_key(get_sandbox_container_name(project, name)))

    def _cleanup_idle_named(self) -> None:
        from sandbox.models import Workspace

        try:
            running = list_running_named_runtimes()
        except Exception as exc:
            logger.warning("Could not list named runtimes for idle cleanup: %s", exc)
            return
        now = time.time()
        for container, runtime_name in running:
            workspace_id = workspace_id_from_container(container)
            if not workspace_id:
                continue
            project = (
                Sandbox.objects.filter(workspace_id=workspace_id).order_by("created_at").first()
                if Workspace.objects.filter(pk=workspace_id).exists() else None
            )
            if project is None:
                continue
            last_active = get_cache(_runtime_activity_key(container))
            if last_active is None:
                # Unknown activity (e.g. after a backend restart): start the idle clock now.
                self._touch_named(container)
                continue
            if now - float(last_active) < self._get_idle_window(project):
                continue
            try:
                self.stop_runtime(project, runtime_name)
                logger.info("Stopped idle named runtime %s", container)
            except Exception as exc:
                logger.warning("Could not stop idle named runtime %s: %s", container, exc)

    def sync_active_file_tree(self, project: "Sandbox") -> None:
        """Refresh the workspace file tree cache."""
        self._sync_file_tree_to_db(project)

    @staticmethod
    def _needs_environment_bootstrap(project: "Sandbox") -> bool:
        return (
            isinstance(project, Sandbox)
            and getattr(project, "filesystem_path", "") != "/workspace"
            and bool(
                getattr(project, "repo_url", "")
                or getattr(project, "repo_full_name", "")
                or getattr(project, "setup_script", "")
                or getattr(project, "state_saved_at", None)
            )
        )

    def ensure_project_bootstrapped(self, project: "Sandbox", sandbox, *, user=None, force: bool = False) -> None:
        if not self._needs_environment_bootstrap(project):
            return
        boot_key = (
            getattr(sandbox, "object_id", None) or getattr(sandbox, "container_name", None) or id(sandbox),
            str(project.uuid),
        )
        bootstrapped = getattr(self, "_bootstrapped_envs", None)
        if bootstrapped is None:
            bootstrapped = set()
            self._bootstrapped_envs = bootstrapped
        if force:
            bootstrapped.discard(boot_key)
        if boot_key in bootstrapped:
            return
        try:
            from sandbox.services.environment_bootstrap import ensure_environment_ready
            result = ensure_environment_ready(project, sandbox, user=user)
            if result.get("ready", True):
                bootstrapped.add(boot_key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Environment bootstrap failed for %s: %s", project.uuid, exc)

    def _sync_file_tree_to_db(self, project: "Sandbox") -> None:
        """Scan the workspace directory and refresh the file cache."""
        from sandbox.services.volume_tools import list_tree

        tree = list_tree(project)
        if not tree and self._needs_environment_bootstrap(project):
            try:
                sandbox = self.get_or_create(project)
                self.ensure_project_bootstrapped(project, sandbox, force=True)
                tree = list_tree(project)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Environment bootstrap before file sync failed for %s: %s", project.uuid, exc)
        new_files_list = []
        for f in tree:
            modified_at = dt.fromtimestamp(f.get("mtime", time.time()), tz=dt_timezone.utc).isoformat()
            new_files_list.append({
                "uuid": f["path"],
                "path": f["path"],
                "is_directory": f.get("is_dir", False),
                "file_size_bytes": f.get("size", 0),
                "mime_type": "inode/directory" if f.get("is_dir") else "text/plain",
                "modified_at": modified_at,
            })
        set_sandbox_files(str(project.uuid), new_files_list)
        logger.info("Synchronized %d files to cache for sandbox %s", len(new_files_list), project.uuid)

    def _terminate_session(self, handle: SandboxHandle) -> None:
        """Stop a sandbox container session; workspace files persist on host mount."""
        try:
            handle.sandbox.terminate()
            logger.info("Stopped sandbox container %s", handle.object_id)
        except Exception as term_exc:
            logger.warning("Failed to stop sandbox container %s: %s", handle.object_id, term_exc)
            raise
        self._clear_workspace_runtime(handle.project)

    def execute_tool(self, project: "Sandbox", tool_name: str, arguments: dict, on_output=None, runtime: str | None = None, workspace_root: str | None = None) -> dict:
        """Execute a file or shell tool inside the workspace's Docker container."""
        started_at = time.monotonic()
        sandbox = self.get_or_create(project, runtime=runtime)

        is_real_env = isinstance(project, Sandbox) and getattr(project, "filesystem_path", "") != "/workspace"
        self.ensure_project_bootstrapped(project, sandbox)

        try:
            tools_file = Path(__file__).resolve().parent / "file_tools.py"
            if tools_file.exists():
                if hasattr(sandbox, "fs"):
                    sandbox.fs.write_text("/var/lib/neuronrunner/file_tools.py", tools_file.read_text(encoding="utf-8"))
                elif hasattr(sandbox, "container_name"):
                    subprocess.run(
                        ["docker", "exec", sandbox.container_name, "mkdir", "-p", "/var/lib/neuronrunner"],
                        check=False,
                    )
                    subprocess.run(
                        ["docker", "cp", str(tools_file), f"{sandbox.container_name}:/var/lib/neuronrunner/file_tools.py"],
                        check=False,
                    )
        except Exception:
            pass

        if workspace_root:
            ws_root = workspace_root
        elif is_real_env:
            from sandbox.services.environment_bootstrap import environment_working_path
            ws_root = environment_working_path(project)
        else:
            ws_root = project.filesystem_path or f"/workspace/{project.slug}"

        env_secrets_b64 = ""
        if is_real_env and getattr(project, "workspace_id", None):
            try:
                from sandbox.services.vm_secrets import resolve_workspace_secrets
                env_secrets = resolve_workspace_secrets(project.workspace, sandbox=project)
                if env_secrets:
                    env_secrets_b64 = base64.b64encode(json.dumps(env_secrets).encode("utf-8")).decode("ascii")
            except Exception:  # noqa: BLE001
                env_secrets_b64 = ""
        env_inject = (
            f"os.environ.update({{str(k): str(v) for k, v in json.loads(base64.b64decode('{env_secrets_b64}').decode('utf-8')).items()}}); "
            if env_secrets_b64
            else ""
        )

        args_b64 = base64.b64encode(json.dumps(arguments).encode()).decode()
        py_code = (
            "import sys, json, base64, os; "
            "sys.path.insert(0, '/var/lib/neuronrunner'); "
            f"{env_inject}"
            f"os.environ['WORKSPACE_ROOT'] = {json.dumps(ws_root)}; "
            "from file_tools import dispatch_file_tool; "
            f"args = json.loads(base64.b64decode('{args_b64}').decode()); "
            f"result = dispatch_file_tool('{tool_name}', args); "
            "print(json.dumps(result))"
        )
        if on_output is not None and tool_name == "shell_exec":
            py_code = (
                "import sys, json, base64, os; "
                "sys.path.insert(0, '/var/lib/neuronrunner'); "
                f"{env_inject}"
                f"os.environ['WORKSPACE_ROOT'] = {json.dumps(ws_root)}; "
                "from file_tools import shell_exec; "
                f"args = json.loads(base64.b64decode('{args_b64}').decode()); "
                "emit = lambda stream, text: print(json.dumps({'stream': stream, 'text': text}), flush=True); "
                "result = shell_exec(**args, on_output=emit); "
                "print(json.dumps({'result': result}), flush=True)"
            )
        cmd = "python3 -c " + shlex.quote(py_code)

        proj_key = _session_key(project)
        self._session_commands.setdefault(proj_key, []).append(
            f"{tool_name}({json.dumps(arguments)})"[:200]
        )

        timeout = int(arguments.get("timeout") or 300) if isinstance(arguments, dict) else 300
        timeout = max(5, min(1800, timeout))

        tool_result: dict = {"error": "Unknown execution error"}
        try:
            if on_output is not None and tool_name == "shell_exec" and hasattr(sandbox, "exec"):
                process = sandbox.exec("python3", "-u", "-c", py_code, timeout=timeout)
                errors = []

                def drain_errors():
                    if getattr(process, "stderr", None):
                        raw = process.stderr.read()
                        errors.append(raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw))

                error_reader = threading.Thread(target=drain_errors, daemon=True)
                error_reader.start()
                for line in process.stdout:
                    try:
                        event = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    if "result" in event:
                        tool_result = event["result"]
                    elif event.get("stream") in {"stdout", "stderr"}:
                        on_output(event["stream"], event.get("text", ""))
                process.wait(timeout=timeout)
                error_reader.join(timeout=1)
                if "error" in tool_result and errors:
                    tool_result = {"error": "".join(errors)}
            elif hasattr(sandbox, "exec"):
                process = sandbox.exec("bash", "-lc", cmd, timeout=timeout)
                if hasattr(process, "wait"):
                    process.wait(timeout=timeout)
                output_str = ""
                stdout = getattr(process, "stdout", None)
                if stdout:
                    raw = stdout.read() if hasattr(stdout, "read") else stdout
                    output_str = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
                parsed_json = None
                if output_str:
                    try:
                        parsed_json = json.loads(output_str.strip())
                    except Exception:
                        pass
                if parsed_json is not None:
                    tool_result = parsed_json
                else:
                    stderr = getattr(process, "stderr", None)
                    err_text = ""
                    if stderr:
                        raw_err = stderr.read() if hasattr(stderr, "read") else stderr
                        err_text = raw_err.decode("utf-8", errors="replace") if isinstance(raw_err, bytes) else str(raw_err)
                    tool_result = {"error": err_text or output_str or "No output from tool"}
            else:
                tool_result = {"error": "Sandbox execution not supported"}
        except Exception as exc:
            logger.exception("Tool %s failed", tool_name)
            tool_result = {"error": str(exc)}

        if tool_name in {"file_write", "file_patch", "file_delete", "file_rename", "directory_create", "shell_exec"}:
            try:
                self._sync_file_tree_to_db(project)
            except Exception as sync_err:
                logger.warning("Failed to sync file tree after %s for %s: %s", tool_name, project.uuid, sync_err)

        from sandbox.models import SandboxAuditLog, SandboxEvent
        from sandbox.services.audit_log import record_sandbox_audit, record_sandbox_event

        duration_ms = int((time.monotonic() - started_at) * 1000)
        err_msg = str(tool_result.get("error") or "") if isinstance(tool_result, dict) else ""
        event_type_map = {
            "shell_exec": SandboxEvent.EVENT_SHELL,
            "file_write": SandboxEvent.EVENT_FILE_WRITE,
            "file_patch": SandboxEvent.EVENT_FILE_WRITE,
            "file_delete": SandboxEvent.EVENT_FILE_WRITE,
            "file_rename": SandboxEvent.EVENT_FILE_WRITE,
            "directory_create": SandboxEvent.EVENT_FILE_WRITE,
            "file_read": SandboxEvent.EVENT_FILE_READ,
        }
        record_sandbox_event(
            sandbox=project,
            event_type=event_type_map.get(tool_name, tool_name),
            payload={"tool": tool_name},
            duration_ms=duration_ms,
            success=not bool(err_msg),
            error_message=err_msg,
        )
        if tool_name == "shell_exec":
            cmd_str = str(arguments.get("command") or "") if isinstance(arguments, dict) else ""
            record_sandbox_audit(
                event_type=SandboxAuditLog.EVENT_SHELL_EXEC,
                sandbox=project,
                runtime_id=_audit_runtime_id(sandbox, project),
                command=cmd_str,
                metadata={"cwd": arguments.get("cwd") if isinstance(arguments, dict) else None, "duration_ms": duration_ms},
            )

        return tool_result


_sandbox_manager = SandboxSessionManager()


def get_sandbox_manager() -> SandboxSessionManager:
    return _sandbox_manager
