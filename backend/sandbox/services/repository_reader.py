"""Read workspace Git repositories and execute explicit index/commit/branch actions.

This module is also executed inside remote workspace runtimes; keep it stdlib-only.
"""
from __future__ import annotations

import difflib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "vendor"}


class RepositoryUnavailable(ValueError):
    code = "repository_unavailable"

    def __init__(self, message="This repository folder was removed or no longer contains a Git repository."):
        super().__init__(message)


def directory(root: Path, workspace_path: str) -> Path:
    path = PurePosixPath(workspace_path)
    if not path.is_absolute() or path.parts[:2] != ("/", "workspace") or ".." in path.parts:
        raise ValueError("Choose a repository inside this workspace.")
    target = (root / str(path.relative_to("/workspace"))).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError("Choose a repository inside this workspace.")
    return target


def is_repository(path: Path, root: Path) -> bool:
    entry = path / ".git"
    if not path.is_dir() or not entry.exists():
        return False
    git_dir = entry.resolve()
    if entry.is_file():
        try:
            with entry.open(errors="replace") as stream:
                text = stream.read(4096).strip()
        except FileNotFoundError:
            return False
        if not text.startswith("gitdir: "):
            return False
        git_dir = (path / text[8:]).resolve()
    return git_dir.is_dir() and git_dir.is_relative_to(root.resolve())


def git(path: Path, *args: str, required: bool = False) -> str:
    try:
        result = subprocess.run(
            ["git", "--literal-pathspecs", "-c", f"safe.directory={path}", *args], cwd=path,
            env={**os.environ, "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"},
            capture_output=True, text=True, errors="replace", timeout=20,
        )
    except FileNotFoundError:
        if not path.is_dir():
            raise RepositoryUnavailable() from None
        raise
    if required and result.returncode:
        message = result.stderr.strip()
        if "would be overwritten" in message or "local changes" in message:
            raise ValueError("Commit your changes before switching branches; Git would overwrite them.")
        if "already checked out" in message:
            raise ValueError("This branch is already checked out in another worktree.")
        if "Permission denied" in message:
            raise ValueError("The workspace runtime cannot write to this repository. Check its file permissions.")
        if ".lock" in message and "File exists" in message:
            raise ValueError("Another Git operation holds a repository lock. Wait for it to finish and retry.")
        if "Authentication failed" in message or "could not read Username" in message or "403" in message:
            raise ValueError("GitHub authentication failed. Make sure your GitHub account is connected with write access.")
        if "non-fast-forward" in message or "[rejected]" in message:
            raise ValueError("Remote has newer commits. Pull or rebase before pushing.")
        raise ValueError("Git could not complete this operation. Check for conflicts or repository locks and try again.")
    return result.stdout if not result.returncode else ""


def git_auth_args(token: str | None) -> list[str]:
    if not token or not isinstance(token, str):
        return []
    import base64
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {basic}"]


def github_repository(remote: str) -> str | None:
    match = re.fullmatch(r"(?:https?://(?:[^/@]+@)?github\.com/|(?:[^@/]+@)?github\.com:|ssh://(?:[^@/]+@)?github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?", remote.strip())
    return match[1] if match else None


def branch_names(path: Path, remote: bool = False) -> list[str]:
    prefix = "refs/remotes/" if remote else "refs/heads/"
    # refname:short abbreviates origin/HEAD to origin and can expand ambiguous
    # branch names. Full references preserve the actual checkout name.
    output = git(path, "for-each-ref", "--format=%(refname)%00%(symref)", prefix)
    names = []
    for line in output.splitlines():
        reference, _, symbolic_target = line.partition("\0")
        if not reference.startswith(prefix) or symbolic_target:
            continue
        name = reference[len(prefix):]
        if not remote or not name.endswith("/HEAD"):
            names.append(name)
    return names


def describe(path: Path, root: Path) -> dict:
    repo = github_repository(git(path, "remote", "get-url", "origin").strip())
    relative = path.relative_to(root.resolve()).as_posix()
    return {
        "path": "/workspace" + (f"/{relative}" if relative != "." else ""),
        "name": path.name if relative != "." else "Workspace",
        "github_repository": repo,
        "remote_url": f"https://github.com/{repo}" if repo else None,
    }


def read_history(path: Path, data: dict | None = None) -> dict:
    data = data or {}
    try:
        offset = int(data.get("offset", 0))
    except (ValueError, TypeError):
        raise ValueError("Choose a valid history offset.") from None
    if offset < 0:
        raise ValueError("Choose a valid history offset.")
    head = data.get("head") or git(path, "rev-parse", "--verify", "HEAD").strip()
    if head and (not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", head)):
        raise ValueError("Choose a valid history commit.")
    history = []
    total_commits = 0
    if head:
        output = git(path, "log", "-21", f"--skip={offset}", "--format=%H%x00%s%x00%an%x00%aI", head, "--", required=True)
        for line in output.splitlines():
            parts = line.split("\0")
            if len(parts) == 4:
                history.append(dict(zip(("hash", "subject", "author", "date"), parts)))
        count = git(path, "rev-list", "--count", head).strip()
        try:
            total_commits = int(count)
        except (ValueError, TypeError):
            total_commits = len(history)
    has_next = len(history) > 20
    return {"history": history[:20], "has_next": has_next, "next_offset": offset + 20 if has_next else None, "head_commit": head, "total_commits": total_commits}


def read(root: Path, operation: str, workspace_path: str = "/workspace", file: str = "", data: dict | None = None) -> dict:
    root = root.resolve()
    if operation == "list":
        repositories = []
        visited = 0
        for current, dirs, _ in os.walk(root, followlinks=False):
            visited += 1
            path = Path(current)
            dirs[:] = sorted(name for name in dirs if name not in SKIP_DIRS and not (path / name).is_symlink())
            try:
                if is_repository(path, root):
                    repositories.append(describe(path, root))
            except (FileNotFoundError, RepositoryUnavailable):
                # A folder can disappear while discovery is walking the tree.
                continue
            if visited >= 10000 or len(repositories) >= 100:
                break
        return {"repositories": repositories}

    path = directory(root, workspace_path)
    if operation == "initialize":
        source = (data or {}).get("source")
        if source == "existing":
            if not is_repository(path, root):
                raise ValueError("Choose an existing folder containing a Git repository.")
        elif source == "new":
            if path.exists():
                raise ValueError("This folder already exists. Choose a new folder path.")
            path.mkdir(parents=True)
            git(path, "init", "--quiet", "--initial-branch=main", required=True)
        else:
            raise ValueError("Choose a valid project source.")
        return describe(path, root)
    if not is_repository(path, root):
        raise RepositoryUnavailable()
    if operation == "history":
        return read_history(path, data)
    if operation in {"stage", "unstage"}:
        data = data or {}
        status = read(root, "status", workspace_path)
        if data.get("all") is True:
            paths = ["."]
        else:
            requested = data.get("files")
            if not isinstance(requested, list) or not 1 <= len(requested) <= 1000 or any(not isinstance(item, str) for item in requested):
                raise ValueError("Choose one or more changed files.")
            changes = {item["path"]: item for item in status["files"]}
            paths = []
            for filename in dict.fromkeys(requested):
                relative = PurePosixPath(filename)
                target = (path / filename).resolve()
                if (not filename or "\0" in filename or relative.is_absolute() or ".." in relative.parts
                        or ".git" in relative.parts or not target.is_relative_to(path) or filename not in changes):
                    raise ValueError("Choose a changed file inside this repository.")
                paths.append(filename)
                previous = changes[filename]["previous_path"]
                if previous:
                    paths.append(previous)
        if operation == "stage":
            # A staged rename's old path is already absent from the index; only
            # include paths Git still tracks or that exist in the working tree.
            paths = [item for item in paths if item == "." or (path / item).exists()
                     or git(path, "ls-files", "--", item).strip()]
            if paths:
                git(path, "add", "-A", "--", *paths, required=True)
        elif status["head_commit"]:
            git(path, "reset", "--quiet", "HEAD", "--", *paths, required=True)
        else:
            # On an unborn branch there is no HEAD to restore. Remove only the
            # index entries, preserving every working-tree byte.
            git(path, "rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", *paths, required=True)
        return read(root, "status", workspace_path)
    if operation == "commit":
        data = data or {}
        message = data.get("message", "")
        if not isinstance(message, str) or not message.strip() or len(message) > 2000 or "\0" in message:
            raise ValueError("Enter a commit message (up to 2000 characters).")
        status = read(root, "status", workspace_path)
        if any(item["status"] == "conflict" for item in status["files"]):
            raise ValueError("Resolve merge conflicts before committing.")
        if not status["files"]:
            raise ValueError("There are no changes to commit.")
        if data.get("staged_only") is True:
            if not any(item["staged"] for item in status["files"]):
                raise ValueError("Stage changes before committing.")
        else:
            git(path, "add", "-A", "--", ".", required=True)
        author = str(data.get("author") or "NeuronRunner")[:100].replace("\n", " ")
        email = str(data.get("email") or "user@neuronrunner.local")[:200].replace("\n", " ")
        git(path, "-c", f"user.name={author}", "-c", f"user.email={email}", "commit", "-m", message.strip(), required=True)
        return read(root, "status", workspace_path)
    if operation == "switch":
        data = data or {}
        branch = data.get("branch")
        if not isinstance(branch, str) or not branch or len(branch) > 250:
            raise ValueError("Choose a valid branch name.")
        git(path, "check-ref-format", "--branch", branch, required=True)
        current_branch = git(path, "symbolic-ref", "HEAD").strip().removeprefix("refs/heads/")
        if not data.get("create") and current_branch == branch:
            return read(root, "status", workspace_path)
        local = branch_names(path)
        if data.get("create") is True:
            if current_branch == branch:
                return read(root, "status", workspace_path)
            if branch in local:
                git(path, "switch", "--no-guess", branch, required=True)
            else:
                git(path, "switch", "-c", branch, required=True)
        else:
            if data.get("fetch") is True and branch not in local:
                clean_remote = branch.partition("/")[2] if branch.startswith("origin/") else branch
                git(path, *git_auth_args(data.get("token")), "fetch", "--quiet", "origin", f"{clean_remote}:refs/remotes/origin/{clean_remote}")
            remote = branch_names(path, remote=True)
            if branch in local:
                git(path, "switch", "--no-guess", branch, required=True)
            elif branch in remote and "/" in branch:
                local_name = branch.partition("/")[2]
                if local_name in local:
                    upstream = git(path, "for-each-ref", "--format=%(upstream)", f"refs/heads/{local_name}").strip()
                    if upstream != f"refs/remotes/{branch}":
                        raise ValueError("A local branch with this name already exists and tracks a different branch. Choose the local branch or create a different name.")
                    git(path, "switch", "--no-guess", local_name, required=True)
                else:
                    git(path, "switch", "--track", branch, required=True)
            elif data.get("fetch") is True and f"origin/{branch}" in remote and "/" not in branch:
                git(path, "switch", "--track", f"origin/{branch}", required=True)
            else:
                raise ValueError("This branch no longer exists. Refresh the branch list.")
        return read(root, "status", workspace_path)
    if operation == "push":
        data = data or {}
        branch = data.get("branch") or git(path, "symbolic-ref", "HEAD").strip().removeprefix("refs/heads/")
        if not isinstance(branch, str) or not branch or branch == "Detached HEAD" or len(branch) > 250:
            raise ValueError("Switch to a valid branch before pushing.")
        git(path, "check-ref-format", "--branch", branch, required=True)
        git(path, *git_auth_args(data.get("token")), "push", "--set-upstream", "origin", f"HEAD:refs/heads/{branch}", required=True)
        return read(root, "status", workspace_path)
    if operation == "status":
        changes = []
        entries = iter(git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all", required=True).split("\0"))
        for entry in entries:
            if not entry:
                continue
            code, filename = entry[:2], entry[3:]
            previous_path = next(entries, "") if "R" in code or "C" in code else None
            conflict = "U" in code or code in ("AA", "DD")
            status = "conflict" if conflict else "untracked" if code == "??" else "renamed" if "R" in code else "deleted" if "D" in code else "added" if "A" in code else "modified"
            changes.append({"path": filename, "previous_path": previous_path, "status": status, "staged": not conflict and code[0] not in (" ", "?"), "index_status": code[0], "worktree_status": code[1]})
        history = read_history(path)
        local = branch_names(path)
        remote = branch_names(path, remote=True)
        branch = git(path, "symbolic-ref", "HEAD").strip().removeprefix("refs/heads/") or "Detached HEAD"
        branches = [{"name": name, "remote": False} for name in local]
        if not local and branch != "Detached HEAD":
            branches.append({"name": branch, "remote": False})
        branches.extend({"name": name, "remote": True} for name in remote if not name.endswith("/HEAD"))
        upstream = git(path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").strip()
        counts = git(path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}").split() if upstream else []
        ahead, behind = (map(int, counts) if len(counts) == 2 else (0, 0))
        return {**describe(path, root), "branch": branch, "branches": branches, "head_commit": history["head_commit"], "files": changes, "history": history["history"],
                "history_has_next": history["has_next"], "history_next_offset": history["next_offset"], "total_commits": history["total_commits"],
                "upstream": upstream or None, "ahead": ahead, "behind": behind}
    if operation == "diff":
        relative = PurePosixPath(file)
        target = (path / file).resolve()
        if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts or not target.is_relative_to(path) or not file:
            raise ValueError("Choose a file inside this repository.")
        head = git(path, "rev-parse", "--verify", "HEAD").strip()
        flags = ("--no-ext-diff", "--no-textconv", "--no-color")
        mode = (data or {}).get("mode", "all")
        if mode not in {"all", "staged", "unstaged"}:
            raise ValueError("Choose a valid diff view.")
        refs = ["--cached"] if mode == "staged" else ["HEAD"] if mode == "all" and head else []
        diff = git(path, "diff", *flags, *refs, "--", file)
        if mode == "all" and not head:
            diff = git(path, "diff", *flags, "--cached", "--", file) + diff
        tracked = git(path, "ls-files", "--", file).strip()
        if mode != "staged" and not tracked and target.is_file():
            if target.stat().st_size > 200000:
                return {"path": file, "diff": "", "message": "This file is too large to preview."}
            data = target.read_bytes()
            if b"\0" in data:
                return {"path": file, "diff": "", "message": "Binary file preview is unavailable."}
            diff = "".join(difflib.unified_diff([], data.decode("utf-8", errors="replace").splitlines(keepends=True), fromfile="/dev/null", tofile=f"b/{file}"))
        return {"path": file, "diff": diff[:200000], "truncated": len(diff) > 200000}
    raise ValueError("Unknown repository operation.")


if __name__ == "__main__":
    try:
        print(json.dumps(read(Path(sys.argv[1]), **json.loads(sys.argv[2]))))
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        result = {"error": str(error) if isinstance(error, ValueError) else "Git could not complete this operation."}
        if isinstance(error, RepositoryUnavailable):
            result["code"] = error.code
        print(json.dumps(result))
