"""Initialize repositories for explicitly created projects in the workspace VM."""
from __future__ import annotations

import base64
import shlex
from pathlib import PurePosixPath


class GitInitializationError(RuntimeError):
    pass


def github_git_setup_command(
    token: str,
    *,
    user_name: str | None = None,
    user_email: str | None = None,
    target_path: str | None = None,
    upstream_url: str | None = None,
) -> str:
    """Build a shell command that makes GitHub pushes work from the VM.

    The token is written to a root-only credentials file and the repository
    gets an ``upstream`` remote when it is a fork.
    """
    if not token:
        return ""
    quote = shlex.quote
    cred_line = f"https://x-access-token:{token}@github.com\n"
    encoded_cred = base64.b64encode(cred_line.encode("utf-8")).decode("ascii")
    commands = [
        "git config --global credential.helper 'store --file=/root/.git-credentials'",
        f"printf '%s' {quote(encoded_cred)} | base64 -d > /root/.git-credentials",
        "chmod 600 /root/.git-credentials",
        "git config --global push.default current",
    ]
    if user_name:
        commands.append(f"git config --global user.name {quote(str(user_name))}")
    if user_email:
        commands.append(f"git config --global user.email {quote(str(user_email))}")
    if target_path and upstream_url:
        commands.append(f"git -C {quote(target_path)} remote remove upstream >/dev/null 2>&1 || true")
        commands.append(f"git -C {quote(target_path)} remote add upstream {quote(upstream_url)}")
    return " && ".join(commands)


def configure_github_git(sandbox, token: str, **kwargs) -> None:
    """Apply GitHub credentials and remote metadata inside a sandbox."""
    command = github_git_setup_command(token, **kwargs)
    if not command:
        return
    process = sandbox.exec("bash", "-lc", command)
    process.wait()


def repository_clone_command(repo_url: str, target_path: str, origin_url: str) -> str:
    """Build a clone command suited to the workspace filesystem."""
    quote = shlex.quote
    guard = (
        f"resolved=$(realpath -m -- {quote(target_path)}) && "
        "case \"$resolved\" in /workspace/*) ;; *) "
        "printf 'Clone destination must stay inside /workspace\\n'; exit 1 ;; esac"
    )
    command = (
        f"{guard} && mkdir -p {quote(str(PurePosixPath(target_path).parent))} && "
        f"GIT_TERMINAL_PROMPT=0 git clone --progress -- {quote(repo_url)} {quote(target_path)}"
    )
    if repo_url != origin_url:
        command += f" && git -C {quote(target_path)} remote set-url origin {quote(origin_url)}"
    return command


def initialize_project_repository(project) -> None:
    """Run git init only when this directory has no existing .git entry."""
    try:
        from sandbox.services.sandbox_service import SandboxBootstrapService
        from sandbox.services.sandbox_session import get_sandbox_manager

        filesystem = SandboxBootstrapService.ensure_workspace_sandbox(project.workspace)
        runtime = get_sandbox_manager().get_or_create(filesystem)
        filesystem.refresh_from_db()
        project.sandbox_object_id = filesystem.sandbox_object_id
        project.terminal_url = filesystem.terminal_url
        project.terminal_token = filesystem.terminal_token
        directory = shlex.quote(project.filesystem_path)
        git_entry = shlex.quote(f"{project.filesystem_path.rstrip('/')}/.git")
        command = (
            f"if [ ! -e {git_entry} ] && [ ! -L {git_entry} ]; then "
            f"mkdir -p -- {directory} && git -C {directory} init --quiet; fi"
            " && printf '\\nNR_GIT_READY\\n'"
        )
        process = runtime.exec("bash", "-lc", command, timeout=60)
        output = b"".join(chunk.encode() if isinstance(chunk, str) else chunk for chunk in process.stdout)
        process.wait()
        if b"NR_GIT_READY" not in output.splitlines():
            raise GitInitializationError("Git initialization did not complete")
    except Exception as exc:
        raise GitInitializationError("The project's Git repository could not be initialized.") from exc
