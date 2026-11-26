"""Give each chat its own Git checkout so parallel agents on one VM never share a working tree.

A conversation that picks a branch gets a private `git worktree` under
/workspace/.worktrees. Its agent tools, per-turn diff and branch picker all point
at that folder, while the project folder keeps whatever branch it had.
"""
import hashlib

from .repository_browser import read_repository

WORKTREE_ROOT = "/workspace/.worktrees"


def project_repository_path(project) -> str:
    return (project.filesystem_path or f"/workspace/{project.slug}").rstrip("/") or "/workspace"


def worktree_path_for(conversation, project) -> str:
    """Deterministic location, tied to both the chat and the repository it was cut from."""
    repository = hashlib.sha1(project_repository_path(project).encode()).hexdigest()[:8]
    return f"{WORKTREE_ROOT}/{conversation.uuid.hex}-{repository}"


def active_worktree_path(conversation, project) -> str | None:
    """The chat's private checkout, or None when it should use the project folder."""
    if not conversation or not project:
        return None
    stored = getattr(conversation, "worktree_path", "") or ""
    if stored and stored == worktree_path_for(conversation, project):
        return stored
    return None


def checkout_status(project, conversation) -> dict:
    """Repository status of the checkout this chat works in (its own worktree, else the project folder)."""
    worktree = active_worktree_path(conversation, project)
    status = read_repository(project, "status", worktree or project_repository_path(project))
    return {**status, "worktree_path": worktree or ""}


def _save(conversation, path: str) -> None:
    conversation.worktree_path = path
    conversation.save(update_fields=["worktree_path"])


def attach_branch(project, conversation, branch: str, create: bool = False, fetch: bool = False, token: str | None = None) -> dict:
    """Point the chat at `branch` and return the repository status of its checkout.

    Choosing the branch the project folder already has keeps the chat on the project
    folder; any other branch gets a private worktree.
    """
    repository = project_repository_path(project)
    if getattr(project, "repo_url", "") or getattr(project, "repo_full_name", ""):
        try:
            from sandbox.services.environment_bootstrap import ensure_environment_ready
            from sandbox.services.sandbox_session import get_sandbox_manager

            runtime = get_sandbox_manager().get_or_create(project)
            ensure_environment_ready(project, runtime)
        except Exception:  # noqa: BLE001
            pass
    current = read_repository(project, "status", repository)
    if branch == current.get("branch") and not create:
        if conversation.worktree_path:
            detach(project, conversation, status=False)
        return {**current, "worktree_path": ""}
    data = {"branch": branch, "create": create, "fetch": fetch, "worktree_path": worktree_path_for(conversation, project)}
    if token:
        data["token"] = token
    status = read_repository(project, "worktree_attach", repository, data=data)
    _save(conversation, data["worktree_path"])
    if getattr(project, "maintenance_script", ""):
        try:
            from sandbox.services.environment_bootstrap import run_maintenance_script
            from sandbox.services.sandbox_session import get_sandbox_manager

            runtime = get_sandbox_manager().get_or_create(project)
            run_maintenance_script(project, runtime, data["worktree_path"])
        except Exception:  # noqa: BLE001
            pass
    return {**status, "worktree_path": data["worktree_path"]}


def detach(project, conversation, status: bool = True) -> dict | None:
    """Return the chat to the project folder and drop its checkout (refused while it has uncommitted work)."""
    repository = project_repository_path(project)
    path = conversation.worktree_path
    if path:
        read_repository(project, "worktree_detach", repository, data={"worktree_path": path})
        _save(conversation, "")
    return read_repository(project, "status", repository) if status else None
