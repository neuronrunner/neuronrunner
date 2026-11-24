"""File operations for workspace container runtimes."""
from __future__ import annotations

from . import workspace_disk


def shared_workspace_project(project):
    """Return a project handle rooted at the shared /workspace directory."""
    from copy import copy

    root = (
        project.workspace.projects.filter(filesystem_path="/workspace").first()
        if getattr(project, "workspace_id", None)
        else None
    )
    if root is None:
        root = copy(project)
        root.filesystem_path = "/workspace"
    return root


def _runtime_path(project, workspace_path: str) -> str:
    """Map a project-relative /workspace path into the shared runtime root."""
    base = (getattr(project, "filesystem_path", "") or f"/workspace/{project.slug}").rstrip("/")
    raw = str(workspace_path or "").strip()
    if raw == "/workspace":
        return base
    rel = raw[len("/workspace/"):] if raw.startswith("/workspace/") else raw.lstrip("/")
    return f"{base}/{rel}" if rel else base


def mkdir_via_daemon(project, workspace_path: str) -> dict:
    """Create a directory on the workspace VM disk."""
    return workspace_disk.mkdir(project, workspace_path)


def mv_via_daemon(project, old_workspace_path: str, new_workspace_path: str) -> dict:
    """Move/rename a file or directory on the workspace VM disk."""
    return workspace_disk.rename(project, old_workspace_path, new_workspace_path)


def write_file(project, workspace_path: str, data: bytes) -> None:
    """Write (or overwrite) a file on the workspace VM disk."""
    workspace_disk.write_file(project, workspace_path, data)


def read_file(project, workspace_path: str) -> bytes | None:
    """Read a file directly from the workspace VM disk."""
    return workspace_disk.read_file(project, workspace_path)


def remove_file(project, workspace_path: str) -> None:
    """Delete a file or directory on the workspace VM disk."""
    workspace_disk.remove(project, workspace_path)


def rename_file(project, old_workspace_path: str, new_workspace_path: str) -> None:
    """Rename/move a file or directory on the workspace VM disk."""
    workspace_disk.rename(project, old_workspace_path, new_workspace_path)


def list_tree(project) -> list[dict]:
    """List the workspace VM disk directory tree."""
    return workspace_disk.list_tree(project)
