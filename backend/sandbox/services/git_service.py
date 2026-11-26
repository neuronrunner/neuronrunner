"""Sandbox Git Service.

Provides Git version control integration for sandbox projects, including:
- Automatic repository initialization
- File changes diff computation
- Undo / revert capability via git
- Checkpointing for turns/generations
"""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)

# A workspace with node_modules or generated artifacts can otherwise produce a
# multi-gigabyte diff in memory and spike the backend process.
MAX_DIFF_BYTES = 2_000_000
MAX_DIFF_LINES = 50_000
MAX_DIFF_FILES = 500
EXCLUDED_DIFF_PATHS = (
    "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build",
    "target", "vendor", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "coverage", ".turbo",
)


def get_shared_workspace_root(project: Any) -> Path:
    """Return the local filesystem root shared by projects in one team workspace."""
    workspace = getattr(project, "workspace", None)
    workspace_id = getattr(workspace, "storage_key", None) or f"user-{getattr(project, 'user_id', 'unknown')}"
    storage_dir = getattr(settings, "LOCAL_WORKSPACE_ROOT", None)
    if not storage_dir:
        storage_dir = getattr(settings, "BASE_DIR", Path.cwd()) / "workspaces"
    shared_dir = Path(storage_dir) / str(workspace_id)
    shared_dir.mkdir(parents=True, exist_ok=True)
    return shared_dir


def get_project_relative_path(project: Any) -> str:
    configured = str(getattr(project, "filesystem_path", "") or "").strip()
    if configured.rstrip("/") == "/workspace":
        return ""
    if configured.startswith("/workspace/"):
        return configured[len("/workspace/"):].strip("/")
    return (getattr(project, "slug", "") or str(getattr(project, "uuid", "unknown"))).strip("/")


class SandboxGitService:
    @staticmethod
    def _exclude_pathspecs() -> list[str]:
        return [f":(exclude){path}" for path in EXCLUDED_DIFF_PATHS]

    @staticmethod
    def _write_git_excludes(ws_dir: Path) -> None:
        """Keep dependency/build directories out of local git operations."""
        exclude_file = ws_dir / ".git" / "info" / "exclude"
        try:
            exclude_file.parent.mkdir(parents=True, exist_ok=True)
            existing = exclude_file.read_text(encoding="utf-8") if exclude_file.exists() else ""
            lines = set(existing.splitlines())
            additions = [f"{path}/" for path in EXCLUDED_DIFF_PATHS if f"{path}/" not in lines]
            if additions:
                with exclude_file.open("a", encoding="utf-8") as handle:
                    if existing and not existing.endswith("\n"):
                        handle.write("\n")
                    handle.write("\n".join(additions) + "\n")
        except Exception:
            pass

    @staticmethod
    def _run_limited(cmd: list[str], cwd: Path, limit: int) -> tuple[str, bool]:
        """Run a command and read at most ``limit`` bytes of stdout."""
        process = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        chunks: list[bytes] = []
        total = 0
        truncated = False
        try:
            while True:
                chunk = process.stdout.read(65536)
                if not chunk:
                    break
                remaining = limit - total
                if remaining <= 0:
                    truncated = True
                    process.kill()
                    break
                if len(chunk) > remaining:
                    chunks.append(chunk[:remaining])
                    truncated = True
                    process.kill()
                    break
                chunks.append(chunk)
                total += len(chunk)
        finally:
            process.wait()
        return b"".join(chunks).decode("utf-8", errors="replace"), truncated

    @staticmethod
    def get_workspace_dir(project: Any, workspace_path: str | None = None) -> Path:
        """Return the local root directory for this sandbox project, or for a chat's private worktree."""
        if workspace_path:
            return get_shared_workspace_root(project) / workspace_path.removeprefix("/workspace/").strip("/")
        return get_shared_workspace_root(project) / get_project_relative_path(project)

    @classmethod
    def is_git_repo(cls, project: Any) -> bool:
        ws_dir = cls.get_workspace_dir(project)
        return (ws_dir / ".git").is_dir()

    @classmethod
    def ensure_git_repo(cls, project: Any, workspace_path: str | None = None) -> bool:
        """Initialize a git repository in the sandbox directory if it doesn't already exist."""
        ws_dir = cls.get_workspace_dir(project, workspace_path)
        if workspace_path:
            # A worktree's .git is a file pointing at the project repository; never initialize one here.
            return (ws_dir / ".git").exists()
        if (ws_dir / ".git").is_dir():
            cls._write_git_excludes(ws_dir)
            return True
        # Git initialization belongs to explicit project creation. A chat in
        # the Files root must not create a repository or a missing directory.
        if not get_project_relative_path(project) or not ws_dir.is_dir():
            return False

        try:
            subprocess.run(["git", "init"], cwd=str(ws_dir), check=True, capture_output=True, text=True)
            cls._write_git_excludes(ws_dir)
            subprocess.run(
                ["git", "config", "user.name", "NeuronRunner Agent"],
                cwd=str(ws_dir),
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                ["git", "config", "user.email", "agent@neuronrunner.ai"],
                cwd=str(ws_dir),
                check=True,
                capture_output=True,
                text=True,
            )
            # Add existing files and create initial commit
            subprocess.run(["git", "add", "-A"], cwd=str(ws_dir), check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "commit", "-m", "Initial workspace state", "--allow-empty"],
                cwd=str(ws_dir),
                check=True,
                capture_output=True,
                text=True,
            )
            logger.info("Initialized git repository for sandbox %s at %s", getattr(project, "uuid", project), ws_dir)
            return True
        except Exception as e:
            logger.error("Failed to initialize git repository for sandbox %s: %s", getattr(project, "uuid", project), e)
            return False

    @classmethod
    def create_checkpoint(cls, project: Any, label: str = "Turn checkpoint", workspace_path: str | None = None) -> str | None:
        """Create a git commit checkpoint so changes can be tracked or undone."""
        if not cls.ensure_git_repo(project, workspace_path):
            return None
        ws_dir = cls.get_workspace_dir(project, workspace_path)
        try:
            subprocess.run(["git", "add", "-A"], cwd=str(ws_dir), check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "commit", "-m", label, "--allow-empty"],
                cwd=str(ws_dir),
                check=True,
                capture_output=True,
                text=True,
            )
            rev_res = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(ws_dir),
                check=True,
                capture_output=True,
                text=True,
            )
            commit_hash = rev_res.stdout.strip()
            logger.info("Created git checkpoint %s for sandbox %s (%s)", commit_hash, getattr(project, "uuid", project), label)
            return commit_hash
        except Exception as e:
            logger.warning("Failed to create git checkpoint for sandbox %s: %s", getattr(project, "uuid", project), e)
            return None

    @classmethod
    def get_diff(cls, project: Any, base_commit: str | None = None, workspace_path: str | None = None) -> dict:
        """Compute the git diff of changes made in the sandbox workspace."""
        if not cls.ensure_git_repo(project, workspace_path):
            return {
                "has_changes": False,
                "files": [],
                "total_additions": 0,
                "total_deletions": 0,
                "raw_diff": "",
                "truncated": False,
            }

        ws_dir = cls.get_workspace_dir(project, workspace_path)

        try:
            exclude = cls._exclude_pathspecs()
            # Stage intent for untracked files so they show up in `git diff`,
            # but never walk dependency/build directories.
            subprocess.run(
                ["git", "add", "-N", ".", *exclude],
                cwd=str(ws_dir), check=False, capture_output=True, text=True,
            )

            ref_args = [base_commit] if base_commit else ["HEAD"]
            # Check if HEAD exists (repo has at least one commit)
            head_check = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=str(ws_dir), capture_output=True, text=True)
            if head_check.returncode != 0:
                ref_args = []

            # 1. Get numstat summary first: it is cheap and tells us whether the
            # full diff is safe to materialize.
            numstat_cmd = ["git", "diff", "--numstat", *ref_args, "--", ".", *exclude]
            numstat_res = subprocess.run(numstat_cmd, cwd=str(ws_dir), capture_output=True, text=True)
            numstat_output = numstat_res.stdout if numstat_res.returncode == 0 else ""

            numstat_lines = 0
            numstat_files = 0
            for line in numstat_output.splitlines():
                parts = line.strip().split("\t")
                if len(parts) >= 3:
                    numstat_files += 1
                    if parts[0].isdigit():
                        numstat_lines += int(parts[0])
                    if parts[1].isdigit():
                        numstat_lines += int(parts[1])

            diff_truncated = numstat_lines > MAX_DIFF_LINES or numstat_files > MAX_DIFF_FILES
            if diff_truncated:
                raw_diff = ""
            else:
                diff_cmd = ["git", "diff", "--no-color", *ref_args, "--", ".", *exclude]
                raw_diff, diff_truncated = cls._run_limited(diff_cmd, ws_dir, MAX_DIFF_BYTES)

            # 2. Get status porcelain (modified, added, deleted)
            status_cmd = ["git", "status", "--porcelain", "--", ".", *exclude]
            status_res = subprocess.run(status_cmd, cwd=str(ws_dir), capture_output=True, text=True)
            status_output = status_res.stdout if status_res.returncode == 0 else ""

            status_map: dict[str, str] = {}
            for line in status_output.splitlines():
                if len(line) >= 4:
                    code = line[:2].strip()
                    file_path = line[3:].strip()
                    # Handle renames e.g. old -> new
                    if " -> " in file_path:
                        file_path = file_path.split(" -> ")[1].strip()
                    if "A" in code or "??" in code:
                        status_map[file_path] = "added"
                    elif "D" in code:
                        status_map[file_path] = "deleted"
                    else:
                        status_map[file_path] = "modified"

            # Parse per-file diff blocks
            file_diff_blocks: dict[str, str] = {}
            if raw_diff:
                current_file = None
                current_lines: list[str] = []
                for line in raw_diff.splitlines():
                    if line.startswith("diff --git "):
                        if current_file and current_lines:
                            file_diff_blocks[current_file] = "\n".join(current_lines)
                        # Extract target filename: diff --git a/foo b/foo
                        parts = line.split(" ")
                        if len(parts) >= 4:
                            b_path = parts[3]
                            if b_path.startswith("b/"):
                                current_file = b_path[2:]
                            else:
                                current_file = b_path
                        current_lines = [line]
                    else:
                        if current_file is not None:
                            current_lines.append(line)
                if current_file and current_lines:
                    file_diff_blocks[current_file] = "\n".join(current_lines)

            files: list[dict] = []
            total_additions = 0
            total_deletions = 0

            for line in numstat_output.splitlines():
                parts = line.strip().split("\t")
                if len(parts) >= 3:
                    add_str, del_str, path = parts[0], parts[1], parts[2]
                    # Binary files show '-'
                    add_count = int(add_str) if add_str.isdigit() else 0
                    del_count = int(del_str) if del_str.isdigit() else 0
                    total_additions += add_count
                    total_deletions += del_count

                    status = status_map.get(path, "modified")
                    f_diff = file_diff_blocks.get(path, "")

                    files.append({
                        "path": path,
                        "status": status,
                        "additions": add_count,
                        "deletions": del_count,
                        "diff": f_diff,
                    })

            # Check if any files from status_map were omitted by numstat (e.g. empty new files)
            recorded_paths = {f["path"] for f in files}
            for path, status in status_map.items():
                if path not in recorded_paths:
                    files.append({
                        "path": path,
                        "status": status,
                        "additions": 0,
                        "deletions": 0,
                        "diff": file_diff_blocks.get(path, ""),
                    })

            has_changes = len(files) > 0 or bool(raw_diff.strip())

            rev_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(ws_dir), capture_output=True, text=True)
            head_commit = rev_head.stdout.strip() if rev_head.returncode == 0 else ""

            return {
                "has_changes": has_changes,
                "files": files,
                "total_additions": total_additions,
                "total_deletions": total_deletions,
                "raw_diff": raw_diff,
                "truncated": diff_truncated,
                "head_commit": head_commit,
            }
        except Exception as e:
            logger.error("Error computing git diff for sandbox %s: %s", getattr(project, "uuid", project), e)
            return {
                "has_changes": False,
                "files": [],
                "total_additions": 0,
                "total_deletions": 0,
                "raw_diff": "",
                "truncated": False,
                "error": str(e),
            }

    @classmethod
    def undo_changes(cls, project: Any, target_commit: str | None = None, workspace_path: str | None = None) -> dict:
        """
        Revert all uncommitted file changes in the workspace using git,
        or reset hard to a specific commit checkpoint.
        """
        if not cls.ensure_git_repo(project, workspace_path):
            return {"success": False, "error": "Git is not available in this workspace"}

        ws_dir = cls.get_workspace_dir(project, workspace_path)

        try:
            if target_commit:
                # Reset hard to target commit
                res = subprocess.run(["git", "reset", "--hard", target_commit], cwd=str(ws_dir), capture_output=True, text=True)
                if res.returncode != 0:
                    return {"success": False, "error": res.stderr or "git reset failed"}
            else:
                # Unstage everything and restore files
                subprocess.run(["git", "restore", "--staged", "."], cwd=str(ws_dir), check=False, capture_output=True, text=True)
                subprocess.run(["git", "restore", "."], cwd=str(ws_dir), check=False, capture_output=True, text=True)

            # Clean untracked files and directories
            clean_res = subprocess.run(["git", "clean", "-fd"], cwd=str(ws_dir), capture_output=True, text=True)

            # Synchronize file tree in sandbox manager / DB
            try:
                from sandbox.services.sandbox_session import get_sandbox_manager
                get_sandbox_manager()._sync_file_tree_to_db(project)
            except Exception as sync_e:
                logger.warning("Failed to sync file tree after git undo: %s", sync_e)

            logger.info("Successfully reverted file changes via git for sandbox %s", getattr(project, "uuid", project))
            return {
                "success": True,
                "message": "File changes successfully reverted via git.",
                "clean_output": clean_res.stdout.strip(),
            }
        except Exception as e:
            logger.exception("Failed to undo changes via git for sandbox %s", getattr(project, "uuid", project))
            return {"success": False, "error": str(e)}

    @classmethod
    def get_status(cls, project: Any) -> dict:
        """Get the repository status: current branch, changed files, commit history."""
        if not cls.is_git_repo(project):
            return {
                "is_git_repo": False,
                "branch": None,
                "has_changes": False,
                "changed_files_count": 0,
            }

        ws_dir = cls.get_workspace_dir(project)
        branch_res = subprocess.run(["git", "branch", "--show-current"], cwd=str(ws_dir), capture_output=True, text=True)
        branch = branch_res.stdout.strip() or "main"

        diff_info = cls.get_diff(project)
        return {
            "is_git_repo": True,
            "branch": branch,
            "has_changes": diff_info["has_changes"],
            "changed_files_count": len(diff_info["files"]),
            "files": diff_info["files"],
            "total_additions": diff_info["total_additions"],
            "total_deletions": diff_info["total_deletions"],
        }
