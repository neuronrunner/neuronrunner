"""Local Docker Sandbox Service.

Provides isolated Docker containers for workspace execution, file operations,
port previews, and interactive PTY terminal sessions.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from django.conf import settings
from sandbox.services.git_service import get_shared_workspace_root

logger = logging.getLogger(__name__)

DEFAULT_SANDBOX_IMAGE = "neuronrunner-sandbox:latest"
FALLBACK_SANDBOX_IMAGE = "python:3.11-slim"


def resolve_sandbox_image() -> str:
    """Return the configured Docker sandbox image, falling back if not built locally."""
    configured = getattr(settings, "DOCKER_SANDBOX_IMAGE", DEFAULT_SANDBOX_IMAGE) or DEFAULT_SANDBOX_IMAGE
    fallback = getattr(settings, "DOCKER_SANDBOX_FALLBACK_IMAGE", FALLBACK_SANDBOX_IMAGE) or FALLBACK_SANDBOX_IMAGE
    inspect = _docker_command(["image", "inspect", configured], timeout=15)
    if inspect.returncode == 0:
        return configured
    if configured == DEFAULT_SANDBOX_IMAGE and fallback:
        logger.info("Sandbox image %s not found locally; using fallback image %s", configured, fallback)
        return fallback
    return configured


DEFAULT_RUNTIME_NAME = "default"
RUNTIME_NAME_MAX_LENGTH = 24
_RUNTIME_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
_NAMED_RUNTIME_SEPARATOR = "-rt-"
WORKSPACE_LABEL = "neuronrunner.workspace"
RUNTIME_LABEL = "neuronrunner.runtime"


def normalize_runtime_name(value: Any) -> str:
    """Validate a runtime name; empty values mean the workspace's default runtime.

    Names are lowercase letters, digits and dashes (max 24 characters) so they can
    be embedded in Docker container names and hostnames.
    """
    name = str(value or "").strip().lower()
    if not name or name == DEFAULT_RUNTIME_NAME:
        return DEFAULT_RUNTIME_NAME
    if len(name) > RUNTIME_NAME_MAX_LENGTH or not _RUNTIME_NAME_RE.match(name):
        raise ValueError(
            "Runtime names use lowercase letters, digits and dashes, "
            f"start and end with a letter or digit, and are at most {RUNTIME_NAME_MAX_LENGTH} characters."
        )
    return name


def is_default_runtime(runtime_name: str | None) -> bool:
    return not runtime_name or runtime_name == DEFAULT_RUNTIME_NAME


def _workspace_container_base(project: Any) -> str:
    workspace_id = getattr(project, "workspace_id", None)
    if workspace_id:
        return f"nr-sandbox-workspace-{workspace_id}"
    user_id = str(getattr(project, "user_id", None) or getattr(project, "uuid", project))
    return f"nr-sandbox-user-{user_id}"


def get_sandbox_container_name(project: Any, runtime_name: str | None = None) -> str:
    """All projects and members of a workspace connect to the same default container.

    Additional named runtimes of the workspace get their own container,
    ``<default container>-rt-<name>``, that mounts the same /workspace folder.
    """
    base = _workspace_container_base(project)
    if is_default_runtime(runtime_name):
        return base
    return f"{base}{_NAMED_RUNTIME_SEPARATOR}{runtime_name}"


def get_project_hostname(project: Any) -> str:
    """Return a clean hostname for the container based on the project slug/display_name."""
    name = (
        getattr(project, "slug", None)
        or getattr(project, "display_name", None)
        or "default"
    )
    clean = re.sub(r"[^a-zA-Z0-9._-]", "-", str(name)).strip("-").lower()
    return clean or "default"


class DockerSandboxError(RuntimeError):
    """Docker could not provide the workspace runtime."""


def _docker_command(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise DockerSandboxError(
            "Docker is not installed or is unavailable. Install Docker Engine or Docker Desktop to run workspace sandboxes."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise DockerSandboxError(f"Docker command '{args[0]}' timed out after {timeout} seconds.") from exc
    return result


def _check_docker_result(result: subprocess.CompletedProcess, action: str) -> None:
    if result.returncode == 0:
        return
    detail = (result.stderr or result.stdout or "Docker returned an error without details.").strip()
    raise DockerSandboxError(f"Docker sandbox {action} failed: {detail[-2000:]}")


def remove_docker_workspace_path(project: Any, workspace_path: str) -> None:
    """Remove container-owned files using the existing shared runtime, without starting it."""
    script = """
import os, shutil, sys
path = sys.argv[1]
root = os.path.realpath('/workspace')
if not path.startswith('/workspace/') or any(part in ('', '.', '..') for part in path[len('/workspace/'):].split('/')):
    raise ValueError('Choose a path inside /workspace')
if os.path.commonpath([root, os.path.realpath(os.path.dirname(path))]) != root:
    raise ValueError('The deletion path escapes /workspace')
if os.path.islink(path):
    os.unlink(path)
elif os.path.isdir(path):
    shutil.rmtree(path)
elif os.path.lexists(path):
    os.unlink(path)
if os.path.lexists(path):
    raise RuntimeError('The workspace path still exists after deletion')
"""
    result = _docker_command([
        "exec", "--user", "0", get_sandbox_container_name(project),
        "python3", "-c", script, workspace_path,
    ])
    _check_docker_result(result, "file deletion")


def get_container_ip(container_name: str) -> str | None:
    """Inspect a running Docker container and return its bridge IP address."""
    res = _docker_command([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
        container_name,
    ], timeout=10)
    if res.returncode != 0:
        return None
    for part in res.stdout.strip().split():
        if part:
            return part
    return None


_UNSET = object()
_self_mounts_cache: Any = _UNSET


def _own_container_mounts() -> list[tuple[str, str]]:
    """Return (destination, source) bind mounts of the container this process runs in.

    Empty when not running inside a Docker container or when it cannot be inspected.
    """
    global _self_mounts_cache
    if _self_mounts_cache is not _UNSET:
        return _self_mounts_cache

    mounts: list[tuple[str, str]] = []
    container_id = os.environ.get("HOSTNAME", "").strip()
    if container_id and os.path.exists("/.dockerenv"):
        try:
            res = _docker_command([
                "inspect", "-f",
                '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}}\t{{.Source}}\n{{end}}{{end}}',
                container_id,
            ], timeout=10)
        except DockerSandboxError:
            res = None
        if res is not None and res.returncode == 0:
            for line in res.stdout.splitlines():
                dest, _, source = line.partition("\t")
                if dest and source:
                    mounts.append((dest.rstrip("/"), source.rstrip("/")))
            # Longest destination first so nested mounts win.
            mounts.sort(key=lambda m: len(m[0]), reverse=True)
    _self_mounts_cache = mounts
    return mounts


def _replace_prefix(path: str, prefix: str, replacement: str) -> str | None:
    prefix = prefix.rstrip("/")
    if path == prefix or path.startswith(prefix + "/"):
        return replacement.rstrip("/") + path[len(prefix):]
    return None


def to_docker_host_path(path: str) -> str:
    """Translate a path as seen by this process into the path the Docker daemon sees.

    When the backend itself runs in a container (sharing the host's Docker socket),
    bind-mount sources are resolved on the Docker host, not inside this container.
    DOCKER_SANDBOX_HOST_WORKSPACE_ROOT sets the host path of LOCAL_WORKSPACE_ROOT
    explicitly; otherwise the backend container's own bind mounts are inspected.
    """
    path = os.path.abspath(path)

    host_root = str(getattr(settings, "DOCKER_SANDBOX_HOST_WORKSPACE_ROOT", "") or "").strip()
    local_root = str(getattr(settings, "LOCAL_WORKSPACE_ROOT", "") or "").strip()
    if host_root and local_root:
        mapped = _replace_prefix(path, os.path.abspath(local_root), host_root)
        if mapped is not None:
            return mapped

    for dest, source in _own_container_mounts():
        mapped = _replace_prefix(path, dest, source)
        if mapped is not None:
            return mapped
    return path


def ensure_docker_sandbox(project: Any, runtime_name: str | None = None) -> str:
    """Ensure one of the workspace's Docker containers is running.

    ``runtime_name`` selects a named runtime; omitted, it is the workspace's
    default container. Every runtime mounts the shared workspace folder to
    /workspace. Returns the container name.
    """
    container_name = get_sandbox_container_name(project, runtime_name)
    hostname = get_project_hostname(project)
    if not is_default_runtime(runtime_name):
        hostname = f"{hostname}-{runtime_name}"[:63].strip("-") or hostname
    cpu = str(float(getattr(project, "sandbox_cpu", 2.0) or 2.0))
    memory = f"{int(getattr(project, 'sandbox_memory', 4096) or 4096)}m"

    workspace_dir = str(get_shared_workspace_root(project))
    os.makedirs(workspace_dir, exist_ok=True)
    host_workspace_dir = to_docker_host_path(workspace_dir)

    # 1. Check if container is already running
    check_res = _docker_command(["inspect", "-f", "{{.State.Running}}", container_name])
    if check_res.returncode != 0:
        detail = (check_res.stderr or check_res.stdout or "").lower()
        if "no such object" not in detail and "no such container" not in detail:
            _check_docker_result(check_res, "connection")
    if check_res.returncode == 0 and check_res.stdout.strip() == "true":
        return container_name

    # 2. A stopped container created with a different workspace mount (e.g. an
    # untranslated in-container path) cannot start; recreate it. Workspace files
    # live in the bind-mounted directory, so they are kept.
    if check_res.returncode == 0:
        mount_res = _docker_command([
            "inspect", "-f",
            '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}',
            container_name,
        ], timeout=10)
        current_source = mount_res.stdout.strip().rstrip("/") if mount_res.returncode == 0 else ""
        if current_source and current_source != host_workspace_dir.rstrip("/"):
            logger.warning(
                "Recreating Docker sandbox %s: workspace mount %s does not match %s",
                container_name, current_source, host_workspace_dir,
            )
            _check_docker_result(_docker_command(["rm", "-f", container_name]), "removal")
            check_res = None

    # 3. If container exists but is stopped, restart it
    if check_res is not None and check_res.returncode == 0:
        _check_docker_result(
            _docker_command(["update", "--cpus", cpu, "--memory", memory, container_name]),
            "resource update",
        )
        _check_docker_result(_docker_command(["start", container_name]), "restart")
        logger.info("Restarted existing Docker sandbox container: %s", container_name)
        return container_name

    # 4. Create a fresh container
    image = resolve_sandbox_image()
    run_cmd = [
        "run", "-d",
        "--name", container_name,
        "--hostname", hostname,
        "--cpus", cpu,
        "--memory", memory,
        "--pids-limit", "256",
        "--security-opt", "no-new-privileges",
        "--label", f"{WORKSPACE_LABEL}={_workspace_container_base(project)}",
        "--label", f"{RUNTIME_LABEL}={runtime_name or DEFAULT_RUNTIME_NAME}",
        "-e", "WORKSPACE_ROOT=/workspace",
        "-v", f"{host_workspace_dir}:/workspace",
        "-w", "/workspace",
    ]
    network = str(getattr(settings, "DOCKER_SANDBOX_NETWORK", "") or "").strip()
    if network:
        run_cmd.extend(["--network", network])

    # Inject workspace secrets into container environment when configured
    workspace = getattr(project, "workspace", None)
    if workspace is not None:
        try:
            from sandbox.services.vm_secrets import resolve_workspace_secrets
            for key, value in resolve_workspace_secrets(workspace).items():
                run_cmd.extend(["-e", f"{key}={value}"])
        except Exception:
            logger.debug("Could not resolve workspace secrets for container %s", container_name, exc_info=True)

    run_cmd.extend([image, "tail", "-f", "/dev/null"])

    _check_docker_result(_docker_command(run_cmd, timeout=600), "startup")
    logger.info(
        "Spawned isolated Docker sandbox container: %s (image: %s, hostname: %s, dir: %s)",
        container_name,
        image,
        hostname,
        workspace_dir,
    )
    return container_name


def _runtime_state(docker_state: str) -> str:
    state = (docker_state or "").strip().lower()
    if state == "running":
        return "running"
    if state in {"created", "restarting"}:
        return "starting"
    return "stopped"


def list_workspace_runtimes(project: Any) -> list[dict[str, Any]]:
    """List the workspace's Docker runtimes: the default one first, then named ones.

    The default runtime is always listed (``not_created`` before its first start).
    """
    base = _workspace_container_base(project)
    result = _docker_command([
        "ps", "-a", "--filter", f"name={base}",
        "--format", "{{.Names}}\t{{.State}}\t{{.CreatedAt}}",
    ], timeout=15)
    _check_docker_result(result, "listing")

    found: dict[str, dict[str, Any]] = {}
    prefix = f"{base}{_NAMED_RUNTIME_SEPARATOR}"
    for line in result.stdout.splitlines():
        container, _, rest = line.strip().partition("\t")
        state, _, created_at = rest.partition("\t")
        if container == base:
            name = DEFAULT_RUNTIME_NAME
        elif container.startswith(prefix):
            name = container[len(prefix):]
        else:
            continue
        found[name] = {
            "uuid": name,
            "name": name,
            "container": container,
            "status": _runtime_state(state),
            "created_at": created_at.strip() or None,
            "is_default": name == DEFAULT_RUNTIME_NAME,
        }

    default = found.pop(DEFAULT_RUNTIME_NAME, None) or {
        "uuid": DEFAULT_RUNTIME_NAME,
        "name": DEFAULT_RUNTIME_NAME,
        "container": base,
        "status": "not_created",
        "created_at": None,
        "is_default": True,
    }
    return [default, *(found[name] for name in sorted(found))]


def count_running_runtimes(project: Any, *, exclude: str | None = None) -> int:
    return sum(
        1 for item in list_workspace_runtimes(project)
        if item["status"] in {"running", "starting"} and item["name"] != exclude
    )


def list_running_named_runtimes() -> list[tuple[str, str]]:
    """Return (container, runtime name) for every running named runtime on this Docker host."""
    result = _docker_command([
        "ps", "--filter", f"label={RUNTIME_LABEL}", "--filter", "status=running",
        "--format", '{{.Names}}\t{{.Label "%s"}}' % RUNTIME_LABEL,
    ], timeout=15)
    _check_docker_result(result, "listing")
    items = []
    for line in result.stdout.splitlines():
        container, _, name = line.strip().partition("\t")
        if container and _NAMED_RUNTIME_SEPARATOR in container and not is_default_runtime(name):
            items.append((container, name))
    return items


def workspace_id_from_container(container: str) -> str | None:
    """Return the workspace id encoded in a workspace runtime container name."""
    prefix = "nr-sandbox-workspace-"
    if not container.startswith(prefix):
        return None
    return container[len(prefix):].split(_NAMED_RUNTIME_SEPARATOR, 1)[0] or None


def stop_docker_runtime(project: Any, runtime_name: str | None = None) -> None:
    """Stop one runtime container; workspace files stay on the shared mount."""
    container = get_sandbox_container_name(project, runtime_name)
    result = _docker_command(["stop", "-t", "2", container], timeout=60)
    detail = (result.stderr or result.stdout or "").lower()
    if result.returncode != 0 and "no such container" not in detail:
        _check_docker_result(result, "stop")


def remove_docker_runtime(project: Any, runtime_name: str) -> None:
    """Delete a named runtime container. The default runtime is never removed."""
    if is_default_runtime(runtime_name):
        raise DockerSandboxError("The default runtime cannot be removed; stop it instead.")
    container = get_sandbox_container_name(project, runtime_name)
    result = _docker_command(["rm", "-f", container], timeout=60)
    detail = (result.stderr or result.stdout or "").lower()
    if result.returncode != 0 and "no such container" not in detail:
        _check_docker_result(result, "removal")


class DockerFsAdapter:
    """Provides a filesystem interface on top of a Docker container."""

    def __init__(self, container_name: str):
        self.container_name = container_name

    def write_text(self, container_path: str, content: str) -> None:
        """Write text content to a file inside the container."""
        dirname = os.path.dirname(container_path)
        cmd = f"mkdir -p '{dirname}' && cat > '{container_path}'"
        proc = subprocess.Popen(
            ["docker", "exec", "-i", self.container_name, "sh", "-c", cmd],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        _, stderr = proc.communicate(input=content.encode("utf-8"))
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Failed to write {container_path} in container {self.container_name}: {err}")

    def read_text(self, container_path: str) -> str:
        """Read text content from a file inside the container."""
        res = subprocess.run(
            ["docker", "exec", self.container_name, "cat", container_path],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            raise RuntimeError(f"Failed to read {container_path} in container {self.container_name}: {res.stderr}")
        return res.stdout


class LocalDockerProcess:
    """Wraps subprocess.Popen to provide a unified sandbox process interface."""

    def __init__(self, popen_proc: subprocess.Popen, stdin_data: bytes | None = None):
        self._proc = popen_proc
        self.stdin = popen_proc.stdin
        self.stdout = popen_proc.stdout
        self.stderr = popen_proc.stderr
        if stdin_data is not None and self.stdin is not None:
            try:
                self.stdin.write(stdin_data)
                self.stdin.flush()
            finally:
                try:
                    self.stdin.close()
                except Exception:
                    pass

    def wait(self, timeout: float | None = None) -> int:
        return self._proc.wait(timeout=timeout)

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode


class LocalDockerSandbox:
    """Isolated local Docker container runtime for workspace execution."""

    def __init__(self, project: Any, runtime_name: str | None = None):
        self.project = project
        self.runtime_name = runtime_name or DEFAULT_RUNTIME_NAME
        self.container_name = (
            ensure_docker_sandbox(project)
            if is_default_runtime(runtime_name)
            else ensure_docker_sandbox(project, runtime_name)
        )
        self.fs = DockerFsAdapter(self.container_name)

        try:
            tools_file = Path(__file__).resolve().parent / "file_tools.py"
            if tools_file.exists():
                self.fs.write_text("/var/lib/neuronrunner/file_tools.py", tools_file.read_text(encoding="utf-8"))
                subprocess.run(
                    ["docker", "exec", self.container_name, "rm", "-f", "/root/file_tools.py"],
                    capture_output=True,
                    check=False,
                )
        except Exception as e:
            logger.warning("Failed to auto-inject file_tools.py into %s: %s", self.container_name, e)

    def exec(self, *cmd, **kwargs) -> LocalDockerProcess:
        pty_mode = kwargs.get("pty", False)
        stdin_payload = kwargs.get("stdin")
        stdin_bytes: bytes | None = None
        if stdin_payload is not None:
            stdin_bytes = stdin_payload.encode("utf-8") if isinstance(stdin_payload, str) else bytes(stdin_payload)

        docker_cmd = ["docker", "exec"]
        if pty_mode:
            docker_cmd.append("-it")
        elif stdin_bytes is not None:
            docker_cmd.append("-i")
        docker_cmd.append(self.container_name)
        docker_cmd.extend(cmd)

        proc = subprocess.Popen(
            docker_cmd,
            stdin=subprocess.PIPE if stdin_bytes is not None else None,
            stdout=subprocess.PIPE if not pty_mode else None,
            stderr=subprocess.PIPE if not pty_mode else None,
        )
        return LocalDockerProcess(proc, stdin_data=stdin_bytes)

    def poll(self) -> int | None:
        res = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", self.container_name],
            capture_output=True,
            text=True,
        )
        if res.returncode == 0 and res.stdout.strip() == "true":
            return None
        return 1

    def touch(self) -> None:
        pass

    def close(self) -> None:
        pass

    def container_ip(self) -> str | None:
        return get_container_ip(self.container_name)

    def terminate(self) -> None:
        try:
            subprocess.run(["docker", "stop", "-t", "2", self.container_name], capture_output=True)
        except Exception as e:
            logger.warning("Failed to stop Docker sandbox %s: %s", self.container_name, e)

    @property
    def object_id(self) -> str:
        return self.container_name
