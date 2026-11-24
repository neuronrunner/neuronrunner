"""Run Git reads and explicit writes on the workspace VM filesystem."""
import json
import logging
from pathlib import Path
import shlex

from .repository_reader import RepositoryUnavailable

logger = logging.getLogger(__name__)


def read_repository(project, operation, workspace_path="/workspace", file="", data=None):
    from .sandbox_service import SandboxBootstrapService
    from .sandbox_session import get_sandbox_manager

    filesystem = SandboxBootstrapService.ensure_workspace_sandbox(project.workspace)
    runtime = get_sandbox_manager().get_or_create(filesystem)
    source = Path(__file__).with_name("repository_reader.py").read_text()
    arguments = json.dumps({"operation": operation, "workspace_path": workspace_path, "file": file, "data": data})
    command = f"python3 -c {shlex.quote(source)} /workspace {shlex.quote(arguments)}"
    process = runtime.exec("bash", "-c", command, timeout=240)
    output = "".join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in process.stdout)
    exit_code = process.wait()
    try:
        result = json.loads(output.strip())
    except json.JSONDecodeError as error:
        logger.warning("Workspace Git %s returned invalid JSON (exit %s)", operation, exit_code)
        raise RuntimeError("Git did not return a valid workspace response.") from error
    if not isinstance(result, dict):
        raise RuntimeError("Git did not return a valid workspace response.")
    if result.get("error"):
        if result.get("code") == RepositoryUnavailable.code:
            raise RepositoryUnavailable()
        raise ValueError(result["error"])
    return result
