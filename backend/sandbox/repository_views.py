"""Workspace Git operations and GitHub pull request reads."""
from authentication.github_connection import get_github_connection
import logging
import os
import subprocess

import requests
from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import models
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView
from social_django.models import UserSocialAuth

from .services import conversation_worktree
from .services.repository_browser import read_repository
from .services.repository_reader import RepositoryUnavailable
from .views import _get_accessible_project, _has_live_runtime, _has_running_vm, _no_vm_response

logger = logging.getLogger(__name__)


def _db_environment_repositories(workspace) -> list[dict]:
    """Return repo-backed Environments from DB so Issues/PRs work even while the VM is offline."""
    if not workspace:
        return []
    from .models import Sandbox
    items = (
        Sandbox.objects.filter(workspace=workspace)
        .exclude(filesystem_path="/workspace")
        .exclude(repo_full_name="", repo_url="")
        .order_by("-is_favorite", "display_name")
    )
    repos = []
    for env in items:
        gh = (env.repo_full_name or "").strip() or None
        repos.append({
            "path": env.filesystem_path,
            "name": env.display_name or env.slug,
            "github_repository": gh,
            "remote_url": (env.repo_url or "").strip() or None,
        })
    return repos


def _db_github_repo_for_path(workspace, req_path: str) -> str | None:
    """Resolve owner/repo from DB Environments when the workspace VM is stopped or repo isn't cloned yet."""
    if not workspace:
        return None
    from .models import Sandbox
    cleaned = (req_path or "").rstrip("/")
    qs = Sandbox.objects.filter(workspace=workspace).exclude(repo_full_name="")
    if cleaned and cleaned != "/workspace":
        match = qs.filter(filesystem_path=cleaned).first()
        if match:
            return match.repo_full_name.strip()
    first = qs.order_by("-is_favorite", "-updated_at").first()
    return first.repo_full_name.strip() if first else None


def _db_environment_status(workspace, req_path: str, user) -> dict | None:
    """Return a RepositoryStatus-compatible payload from DB + GitHub branches when the VM is offline."""
    if not workspace:
        return None
    from .models import Sandbox
    cleaned = (req_path or "").rstrip("/")
    qs = Sandbox.objects.filter(workspace=workspace).exclude(filesystem_path="/workspace")
    env = qs.filter(filesystem_path=cleaned).first() if cleaned and cleaned != "/workspace" else None
    if env is None:
        return None
    default_branch = (env.default_branch or "main").strip() or "main"
    gh_repo = (env.repo_full_name or "").strip() or None
    branches: list[dict] = []
    if gh_repo and "/" in gh_repo:
        headers = {"Accept": "application/vnd.github+json"}
        token = _get_user_github_token(user) if user else None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            resp = requests.get(
                f"https://api.github.com/repos/{gh_repo}/branches",
                headers=headers,
                params={"per_page": 100},
                timeout=6,
                allow_redirects=False,
            )
            if resp.status_code == 200:
                for item in resp.json():
                    name = (item.get("name") or "").strip()
                    if name:
                        branches.append({"name": name, "remote": name != default_branch})
        except (requests.RequestException, ValueError, TypeError):
            pass
    if not any(b["name"] == default_branch for b in branches):
        branches.insert(0, {"name": default_branch, "remote": False})
    return {
        "path": env.filesystem_path,
        "name": env.display_name or env.slug,
        "github_repository": gh_repo,
        "remote_url": (env.repo_url or "").strip() or None,
        "branch": default_branch,
        "branches": branches,
        "head_commit": "",
        "upstream": None,
        "ahead": 0,
        "behind": 0,
        "files": [],
        "history": [],
        "history_has_next": False,
        "history_next_offset": None,
        "total_commits": 0,
    }


class RepositoryReadView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    operation = "list"

    def get(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        req_path = request.query_params.get("path", "/workspace")
        if request.query_params.get("wake") == "1" and getattr(project, "workspace", None):
            from .views import _bind_workspace_runtime_vm, _resolve_and_wake_vm

            try:
                vm = _resolve_and_wake_vm(
                    project.workspace,
                    request.user,
                    vm_uuid=request.query_params.get("vm_uuid"),
                )
                if vm:
                    _bind_workspace_runtime_vm(project, vm)
            except (RuntimeError, TimeoutError) as exc:
                return Response({"error": str(exc)}, status=503)
        if not _has_live_runtime(project):
            if self.operation == "list":
                return Response({"repositories": _db_environment_repositories(getattr(project, "workspace", None))})
            if self.operation == "status":
                fallback = _db_environment_status(getattr(project, "workspace", None), req_path, request.user)
                if fallback is not None:
                    return Response(fallback)
            return _no_vm_response()
        try:
            payload = read_repository(project, self.operation, req_path, request.query_params.get("file", ""), data={"mode": request.query_params.get("mode", "all"), "offset": request.query_params.get("offset", "0"), "head": request.query_params.get("head", "")})
            if self.operation == "list" and isinstance(payload, dict):
                live = list(payload.get("repositories") or [])
                seen = {item.get("path") for item in live if isinstance(item, dict)}
                for env_repo in _db_environment_repositories(getattr(project, "workspace", None)):
                    if env_repo["path"] not in seen:
                        live.append(env_repo)
                        seen.add(env_repo["path"])
                payload = {**payload, "repositories": live}
            return Response(payload)
        except RepositoryUnavailable as error:
            if self.operation == "status":
                fallback = _db_environment_status(getattr(project, "workspace", None), req_path, request.user)
                if fallback is not None:
                    return Response(fallback)
            return Response({"error": str(error), "code": error.code}, status=404)
        except (ValueError, OSError, subprocess.TimeoutExpired):
            return Response({"error": "Git could not read this repository or file. Refresh and try again."}, status=400)
        except Exception:
            logger.exception("Workspace repository read failed")
            return Response({"error": "The workspace is temporarily unavailable."}, status=503)


class RepositoryStatusView(RepositoryReadView):
    operation = "status"


class RepositoryDiffView(RepositoryReadView):
    operation = "diff"


class RepositoryHistoryView(RepositoryReadView):
    operation = "history"


def _requested_account(request):
    data = request.data if isinstance(getattr(request, "data", None), dict) else {}
    return request.query_params.get("account") or data.get("account")


def _get_user_github_token(user, account=None):
    connection = get_github_connection(user, account)
    token = (connection.extra_data or {}).get("access_token") if connection else None
    if not token:
        token = getattr(settings, "GITHUB_TOKEN", None) or os.getenv("GITHUB_TOKEN")
    return token


class RepositoryWriteView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    operation = "commit"

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()
        fetch_flag = request.data.get("fetch") is True
        data = {"message": request.data.get("message"), "branch": request.data.get("branch"), "create": request.data.get("create") is True,
                "files": request.data.get("files"), "all": request.data.get("all") is True, "staged_only": request.data.get("staged_only") is True,
                "author": request.user.get_full_name() or request.user.username, "email": request.user.email}
        if fetch_flag:
            data["fetch"] = True
        if self.operation == "push" or fetch_flag:
            token = _get_user_github_token(request.user, _requested_account(request))
            if token:
                data["token"] = token
        try:
            return Response(read_repository(project, self.operation, request.data.get("path", "/workspace"), data=data))
        except RepositoryUnavailable as error:
            return Response({"error": str(error), "code": error.code}, status=404)
        except ValueError as error:
            return Response({"error": str(error)}, status=400)
        except (OSError, subprocess.TimeoutExpired):
            return Response({"error": "Git could not complete this operation. Refresh and try again."}, status=400)
        except Exception:
            logger.exception("Workspace Git operation failed")
            return Response({"error": "The workspace is temporarily unavailable."}, status=503)


class RepositorySwitchView(RepositoryWriteView):
    operation = "switch"


class RepositoryWorktreeView(APIView):
    """Pick the branch a single chat works on, without touching the project folder or other chats.

    The URL sandbox only proves workspace access; the chat's own project decides which repository is used.
    """
    permission_classes = [permissions.IsAuthenticated]

    def _context(self, request, sandbox_uuid):
        from chat.models import Conversation
        from .services.sandbox_service import SandboxBootstrapService

        access = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(access):
            return None, None, _no_vm_response()
        conversation_id = request.data.get("conversation_id") or request.query_params.get("conversation_id")
        conversation = None
        try:
            if conversation_id:
                conversation = Conversation.objects.filter(pk=conversation_id).filter(
                    models.Q(user=request.user) | models.Q(workspace__memberships__user=request.user)
                ).distinct().first()
        except (ValueError, DjangoValidationError):
            conversation = None
        project = SandboxBootstrapService.conversation_project(conversation) if conversation else None
        if not project or project.workspace_id != access.workspace_id:
            return None, None, Response({"error": "Start the chat in this project before choosing its branch."}, status=404)
        requested = request.data.get("path") or request.query_params.get("path")
        if requested and str(requested).rstrip("/") != conversation_worktree.project_repository_path(project):
            return None, None, Response({"error": "This chat works in a different project."}, status=400)
        return project, conversation, None

    def _run(self, request, sandbox_uuid, action):
        project, conversation, failure = self._context(request, sandbox_uuid)
        if failure:
            return failure
        try:
            return Response(action(project, conversation))
        except RepositoryUnavailable as error:
            return Response({"error": str(error), "code": error.code}, status=404)
        except ValueError as error:
            return Response({"error": str(error)}, status=400)
        except (OSError, subprocess.TimeoutExpired):
            return Response({"error": "Git could not complete this operation. Refresh and try again."}, status=400)
        except Exception:
            logger.exception("Chat worktree operation failed")
            return Response({"error": "The workspace is temporarily unavailable."}, status=503)

    def get(self, request, sandbox_uuid):
        return self._run(request, sandbox_uuid, conversation_worktree.checkout_status)

    def post(self, request, sandbox_uuid):
        branch = request.data.get("branch")
        if not isinstance(branch, str) or not branch:
            return Response({"error": "Choose a valid branch name."}, status=400)
        token = _get_user_github_token(request.user, _requested_account(request)) if request.data.get("fetch") is True else None
        return self._run(request, sandbox_uuid, lambda project, conversation: conversation_worktree.attach_branch(
            project, conversation, branch, create=request.data.get("create") is True, fetch=request.data.get("fetch") is True, token=token))

    def delete(self, request, sandbox_uuid):
        return self._run(request, sandbox_uuid, conversation_worktree.detach)


class RepositoryPushView(RepositoryWriteView):
    operation = "push"


class RepositoryStageView(RepositoryWriteView):
    operation = "stage"


class RepositoryUnstageView(RepositoryWriteView):
    operation = "unstage"


def _get_github_repo_context(user, sandbox_uuid, request):
    project = _get_accessible_project(user, sandbox_uuid)
    req_path = request.query_params.get("path")
    if not req_path and hasattr(request, "data") and isinstance(request.data, dict):
        req_path = request.data.get("path")
    req_path = req_path or "/workspace"
    repo = None
    if _has_live_runtime(project):
        try:
            repository = read_repository(project, "status", req_path)
            repo = repository.get("github_repository")
        except RepositoryUnavailable:
            repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
            if not repo:
                return None, None, Response({"error": "Repository unavailable.", "code": RepositoryUnavailable.code}, status=404)
        except (ValueError, OSError, subprocess.TimeoutExpired):
            repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
            if not repo:
                return None, None, Response({"error": "Choose a Git repository in this workspace."}, status=400)
        except Exception:
            repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
            if not repo:
                return None, None, Response({"error": "The workspace is temporarily unavailable."}, status=503)
    else:
        repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
        if not repo:
            return None, None, _no_vm_response()
    if not repo:
        return None, None, None
    token = _get_user_github_token(user)
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return repo, headers, None


def _handle_github_error(response, default_404="Repository unavailable. For private repositories, sign in with a GitHub account that has access."):
    message = "GitHub is temporarily unavailable. Try again later."
    if response.status_code == 404:
        message = default_404
    elif response.status_code == 401:
        message = "Your GitHub connection has expired. Sign in with GitHub again."
    elif response.status_code in (403, 429):
        message = "GitHub denied access or its request limit was reached. Try again later."
    return Response({"error": message}, status=502)


class RepositoryPullRequestsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid):
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"repository": None, "pull_requests": [], "has_next": False})
        state = request.query_params.get("state", "open")
        try:
            page = int(request.query_params.get("page", "1"))
        except (ValueError, TypeError):
            page = 0
        try:
            per_page = int(request.query_params.get("per_page", "30"))
        except (ValueError, TypeError):
            per_page = 30
        per_page = max(1, min(per_page, 100))
        if state not in ("open", "closed") or not 1 <= page <= 100:
            return Response({"error": "Invalid pull request filter."}, status=400)
        try:
            response = requests.get(
                f"https://api.github.com/repos/{repo}/pulls",
                headers=headers,
                params={"state": state, "page": page, "per_page": per_page, "sort": "updated", "direction": "desc"},
                timeout=15,
                allow_redirects=False,
            )
            if response.status_code != 200:
                return _handle_github_error(response)
            pulls = []
            for item in response.json():
                author_user = item.get("user") or {}
                raw_labels = item.get("labels") or []
                labels = [
                    {
                        "name": label["name"],
                        "color": label.get("color", "666666"),
                        "description": label.get("description") or "",
                    }
                    for label in raw_labels
                    if isinstance(label, dict) and "name" in label
                ]
                raw_assignees = item.get("assignees") or []
                assignees = [
                    {
                        "login": a["login"],
                        "avatar_url": a.get("avatar_url") or "",
                    }
                    for a in raw_assignees
                    if isinstance(a, dict) and "login" in a
                ]
                head_data = item.get("head") or {}
                base_data = item.get("base") or {}
                pulls.append({
                    "number": item["number"],
                    "title": item["title"],
                    "url": f"https://github.com/{repo}/pull/{item['number']}",
                    "state": "merged" if item.get("merged_at") else "draft" if item.get("draft") and item["state"] == "open" else item["state"],
                    "draft": bool(item.get("draft")),
                    "author": author_user.get("login", ""),
                    "author_avatar": author_user.get("avatar_url", ""),
                    "created_at": item.get("created_at"),
                    "updated_at": item.get("updated_at"),
                    "closed_at": item.get("closed_at"),
                    "merged_at": item.get("merged_at"),
                    "head": head_data.get("ref", ""),
                    "head_sha": head_data.get("sha", ""),
                    "base": base_data.get("ref", ""),
                    "base_sha": base_data.get("sha", ""),
                    "body": item.get("body") or "",
                    "labels": labels,
                    "assignees": assignees,
                    "comments": item.get("comments", 0),
                })
            return Response({"repository": repo, "pull_requests": pulls, "has_next": "next" in response.links})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Pull requests could not be loaded from GitHub. Try again."}, status=502)

    def post(self, request, sandbox_uuid):
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"error": "This repository is not connected to GitHub."}, status=400)
        if "Authorization" not in headers:
            return Response({"error": "Connect your GitHub account to create a pull request."}, status=401)
        title = str(request.data.get("title") or "").strip()
        head = str(request.data.get("head") or "").strip()
        base = str(request.data.get("base") or "").strip()
        body = str(request.data.get("body") or "")
        draft = bool(request.data.get("draft"))
        if not title or not head:
            return Response({"error": "Pull request title and head branch are required."}, status=400)
        try:
            if not base:
                repo_resp = requests.get(f"https://api.github.com/repos/{repo}", headers=headers, timeout=10)
                if repo_resp.status_code == 200:
                    base = repo_resp.json().get("default_branch") or "main"
                else:
                    base = "main"
            response = requests.post(
                f"https://api.github.com/repos/{repo}/pulls",
                headers=headers,
                json={"title": title, "head": head, "base": base, "body": body, "draft": draft},
                timeout=15,
            )
            if response.status_code not in (200, 201):
                try:
                    err_json = response.json()
                    errors = err_json.get("errors") or []
                    first_err = errors[0].get("message") if errors and isinstance(errors[0], dict) else None
                    msg = first_err or err_json.get("message") or "Could not create pull request on GitHub."
                except ValueError:
                    msg = "Could not create pull request on GitHub."
                return Response({"error": msg}, status=400 if response.status_code == 422 else 502)
            item = response.json()
            author_user = item.get("user") or {}
            head_data = item.get("head") or {}
            base_data = item.get("base") or {}
            pull_data = {
                "number": item["number"],
                "title": item["title"],
                "url": item.get("html_url") or f"https://github.com/{repo}/pull/{item['number']}",
                "state": "draft" if item.get("draft") else item.get("state", "open"),
                "draft": bool(item.get("draft")),
                "author": author_user.get("login", ""),
                "author_avatar": author_user.get("avatar_url", ""),
                "created_at": item.get("created_at"),
                "updated_at": item.get("updated_at"),
                "head": head_data.get("ref", head),
                "base": base_data.get("ref", base),
                "body": item.get("body") or "",
            }
            return Response({"repository": repo, "pull_request": pull_data}, status=201)
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Pull request could not be created on GitHub. Try again."}, status=502)


class RepositoryPullRequestDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid, pull_number=None):
        if pull_number is None:
            try:
                pull_number = int(request.query_params.get("pull_number") or request.query_params.get("number") or 0)
            except (ValueError, TypeError):
                pull_number = 0
        if not pull_number:
            return Response({"error": "Pull request number is required."}, status=400)
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"repository": None, "pull_request": None})
        try:
            response = requests.get(
                f"https://api.github.com/repos/{repo}/pulls/{pull_number}",
                headers=headers,
                timeout=15,
                allow_redirects=False,
            )
            if response.status_code != 200:
                return _handle_github_error(response, "Pull request not found.")
            item = response.json()
            author_user = item.get("user") or {}
            raw_labels = item.get("labels") or []
            labels = [
                {
                    "name": label["name"],
                    "color": label.get("color", "666666"),
                    "description": label.get("description") or "",
                }
                for label in raw_labels
                if isinstance(label, dict) and "name" in label
            ]
            raw_assignees = item.get("assignees") or []
            assignees = [
                {
                    "login": a["login"],
                    "avatar_url": a.get("avatar_url") or "",
                }
                for a in raw_assignees
                if isinstance(a, dict) and "login" in a
            ]
            raw_reviewers = item.get("requested_reviewers") or []
            requested_reviewers = [
                {
                    "login": r["login"],
                    "avatar_url": r.get("avatar_url") or "",
                }
                for r in raw_reviewers
                if isinstance(r, dict) and "login" in r
            ]
            raw_milestone = item.get("milestone")
            milestone = None
            if isinstance(raw_milestone, dict) and raw_milestone.get("title"):
                milestone = {
                    "title": raw_milestone.get("title", ""),
                    "state": raw_milestone.get("state", "open"),
                    "due_on": raw_milestone.get("due_on"),
                }
            head_data = item.get("head") or {}
            base_data = item.get("base") or {}
            pull_data = {
                "number": item["number"],
                "title": item["title"],
                "url": f"https://github.com/{repo}/pull/{item['number']}",
                "state": "merged" if item.get("merged_at") else "draft" if item.get("draft") and item["state"] == "open" else item["state"],
                "draft": bool(item.get("draft")),
                "author": author_user.get("login", ""),
                "author_avatar": author_user.get("avatar_url", ""),
                "created_at": item.get("created_at"),
                "updated_at": item.get("updated_at"),
                "closed_at": item.get("closed_at"),
                "merged_at": item.get("merged_at"),
                "head": head_data.get("ref", ""),
                "head_sha": head_data.get("sha", ""),
                "base": base_data.get("ref", ""),
                "base_sha": base_data.get("sha", ""),
                "body": item.get("body") or "",
                "labels": labels,
                "assignees": assignees,
                "requested_reviewers": requested_reviewers,
                "milestone": milestone,
                "commits_count": item.get("commits", 0),
                "additions": item.get("additions", 0),
                "deletions": item.get("deletions", 0),
                "changed_files": item.get("changed_files", 0),
                "comments_count": item.get("comments", 0),
                "review_comments_count": item.get("review_comments", 0),
                "mergeable": item.get("mergeable"),
                "mergeable_state": item.get("mergeable_state"),
            }
            return Response({"repository": repo, "pull_request": pull_data})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Pull request details could not be loaded from GitHub. Try again."}, status=502)


class RepositoryPullRequestFilesView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid, pull_number=None):
        if pull_number is None:
            try:
                pull_number = int(request.query_params.get("pull_number") or request.query_params.get("number") or 0)
            except (ValueError, TypeError):
                pull_number = 0
        if not pull_number:
            return Response({"error": "Pull request number is required."}, status=400)
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"repository": None, "pull_number": pull_number, "files": []})
        try:
            response = requests.get(
                f"https://api.github.com/repos/{repo}/pulls/{pull_number}/files",
                headers=headers,
                params={"per_page": 100},
                timeout=15,
                allow_redirects=False,
            )
            if response.status_code != 200:
                return _handle_github_error(response, "Pull request files not found.")
            raw_files = response.json() if isinstance(response.json(), list) else []
            files = [
                {
                    "sha": f.get("sha", ""),
                    "filename": f.get("filename", ""),
                    "status": f.get("status", "modified"),
                    "additions": f.get("additions", 0),
                    "deletions": f.get("deletions", 0),
                    "changes": f.get("changes", 0),
                    "patch": f.get("patch") or "",
                    "previous_filename": f.get("previous_filename"),
                }
                for f in raw_files
                if isinstance(f, dict)
            ]
            return Response({"repository": repo, "pull_number": pull_number, "files": files})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Pull request files could not be loaded from GitHub. Try again."}, status=502)


class RepositoryPullRequestCommitsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid, pull_number=None):
        if pull_number is None:
            try:
                pull_number = int(request.query_params.get("pull_number") or request.query_params.get("number") or 0)
            except (ValueError, TypeError):
                pull_number = 0
        if not pull_number:
            return Response({"error": "Pull request number is required."}, status=400)
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"repository": None, "pull_number": pull_number, "commits": []})
        try:
            response = requests.get(
                f"https://api.github.com/repos/{repo}/pulls/{pull_number}/commits",
                headers=headers,
                params={"per_page": 100},
                timeout=15,
                allow_redirects=False,
            )
            if response.status_code != 200:
                return _handle_github_error(response, "Pull request commits not found.")
            raw_commits = response.json() if isinstance(response.json(), list) else []
            commits = [
                {
                    "sha": c.get("sha", ""),
                    "short_sha": (c.get("sha") or "")[:7],
                    "message": ((c.get("commit") or {}).get("message") or "").strip(),
                    "author_name": ((c.get("commit") or {}).get("author") or {}).get("name", ""),
                    "author_login": (c.get("author") or {}).get("login", ""),
                    "author_avatar": (c.get("author") or {}).get("avatar_url", ""),
                    "date": ((c.get("commit") or {}).get("author") or {}).get("date", ""),
                    "url": c.get("html_url") or "",
                }
                for c in raw_commits
                if isinstance(c, dict)
            ]
            return Response({"repository": repo, "pull_number": pull_number, "commits": commits})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Pull request commits could not be loaded from GitHub. Try again."}, status=502)


class RepositoryPullRequestCommentsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid, pull_number=None):
        if pull_number is None:
            try:
                pull_number = int(request.query_params.get("pull_number") or request.query_params.get("number") or 0)
            except (ValueError, TypeError):
                pull_number = 0
        if not pull_number:
            return Response({"error": "Pull request number is required."}, status=400)
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"repository": None, "pull_number": pull_number, "comments": []})
        try:
            # Fetch both issue comments and review comments
            comments = []
            issue_res = requests.get(
                f"https://api.github.com/repos/{repo}/issues/{pull_number}/comments",
                headers=headers,
                params={"per_page": 100},
                timeout=15,
                allow_redirects=False,
            )
            if issue_res.status_code == 200 and isinstance(issue_res.json(), list):
                for c in issue_res.json():
                    if isinstance(c, dict):
                        comments.append({
                            "id": c.get("id"),
                            "url": c.get("html_url") or "",
                            "author": (c.get("user") or {}).get("login", ""),
                            "author_avatar": (c.get("user") or {}).get("avatar_url", ""),
                            "created_at": c.get("created_at"),
                            "updated_at": c.get("updated_at"),
                            "body": c.get("body") or "",
                            "type": "issue_comment",
                        })

            review_res = requests.get(
                f"https://api.github.com/repos/{repo}/pulls/{pull_number}/comments",
                headers=headers,
                params={"per_page": 100},
                timeout=15,
                allow_redirects=False,
            )
            if review_res.status_code == 200 and isinstance(review_res.json(), list):
                for c in review_res.json():
                    if isinstance(c, dict):
                        comments.append({
                            "id": c.get("id"),
                            "url": c.get("html_url") or "",
                            "author": (c.get("user") or {}).get("login", ""),
                            "author_avatar": (c.get("user") or {}).get("avatar_url", ""),
                            "created_at": c.get("created_at"),
                            "updated_at": c.get("updated_at"),
                            "body": c.get("body") or "",
                            "type": "review_comment",
                            "path": c.get("path"),
                            "line": c.get("line") or c.get("original_line"),
                            "diff_hunk": c.get("diff_hunk"),
                        })

            comments.sort(key=lambda x: x.get("created_at") or "")
            return Response({"repository": repo, "pull_number": pull_number, "comments": comments})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Pull request comments could not be loaded from GitHub. Try again."}, status=502)


class RepositoryPullRequestChecksView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid, pull_number=None):
        if pull_number is None:
            try:
                pull_number = int(request.query_params.get("pull_number") or request.query_params.get("number") or 0)
            except (ValueError, TypeError):
                pull_number = 0
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"repository": None, "pull_number": pull_number, "total_count": 0, "checks": []})
        
        head_sha = request.query_params.get("ref") or request.query_params.get("sha")
        try:
            if not head_sha and pull_number:
                pr_res = requests.get(
                    f"https://api.github.com/repos/{repo}/pulls/{pull_number}",
                    headers=headers,
                    timeout=15,
                    allow_redirects=False,
                )
                if pr_res.status_code == 200:
                    head_sha = ((pr_res.json().get("head") or {}).get("sha"))
            if not head_sha:
                return Response({"repository": repo, "pull_number": pull_number, "total_count": 0, "checks": []})

            checks_res = requests.get(
                f"https://api.github.com/repos/{repo}/commits/{head_sha}/check-runs",
                headers=headers,
                params={"per_page": 100},
                timeout=15,
                allow_redirects=False,
            )
            checks = []
            if checks_res.status_code == 200:
                payload = checks_res.json()
                raw_runs = payload.get("check_runs", []) if isinstance(payload, dict) else []
                for r in raw_runs:
                    if isinstance(r, dict):
                        checks.append({
                            "id": r.get("id"),
                            "name": r.get("name", ""),
                            "status": r.get("status", "completed"),
                            "conclusion": r.get("conclusion"),
                            "url": r.get("html_url") or "",
                            "started_at": r.get("started_at"),
                            "completed_at": r.get("completed_at"),
                        })
            return Response({
                "repository": repo,
                "pull_number": pull_number,
                "head_sha": head_sha,
                "total_count": len(checks),
                "checks": checks,
            })
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Checks could not be loaded from GitHub. Try again."}, status=502)


def _serialize_issue(repo, item):
    """Normalize a GitHub issue JSON object into the API response shape."""
    raw_labels = item.get("labels") or []
    labels = [
        {
            "name": label["name"],
            "color": label.get("color", "666666"),
            "description": label.get("description") or "",
        }
        for label in raw_labels
        if isinstance(label, dict) and "name" in label
    ]
    author_user = item.get("user") or {}
    raw_assignees = item.get("assignees") or []
    assignees = [
        {
            "login": a["login"],
            "avatar_url": a.get("avatar_url") or "",
        }
        for a in raw_assignees
        if isinstance(a, dict) and "login" in a
    ]
    raw_milestone = item.get("milestone")
    milestone = None
    if isinstance(raw_milestone, dict) and raw_milestone.get("title"):
        milestone = {
            "title": raw_milestone.get("title", ""),
            "state": raw_milestone.get("state", "open"),
            "due_on": raw_milestone.get("due_on"),
        }
    return {
        "number": item["number"],
        "title": item["title"],
        "url": f"https://github.com/{repo}/issues/{item['number']}",
        "state": item["state"],
        "state_reason": item.get("state_reason"),
        "author": author_user.get("login", ""),
        "author_avatar": author_user.get("avatar_url", ""),
        "assignees": assignees,
        "milestone": milestone,
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "closed_at": item.get("closed_at"),
        "comments": item.get("comments", 0),
        "labels": labels,
        "body": item.get("body") or "",
    }


class RepositoryIssuesView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        req_path = request.query_params.get("path", "/workspace")
        repo = None
        if _has_live_runtime(project):
            try:
                repository = read_repository(project, "status", req_path)
                repo = repository["github_repository"]
            except RepositoryUnavailable as error:
                repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
                if not repo:
                    return Response({"error": str(error), "code": error.code}, status=404)
            except (ValueError, OSError, subprocess.TimeoutExpired):
                repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
                if not repo:
                    return Response({"error": "Choose a Git repository in this workspace."}, status=400)
            except Exception:
                repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
                if not repo:
                    return Response({"error": "The workspace is temporarily unavailable."}, status=503)
        else:
            repo = _db_github_repo_for_path(getattr(project, "workspace", None), req_path)
            if not repo:
                return _no_vm_response()
        if not repo:
            return Response({"repository": None, "issues": [], "has_next": False})
        state = request.query_params.get("state", "open")
        try:
            page = int(request.query_params.get("page", "1"))
        except (ValueError, TypeError):
            page = 0
        try:
            per_page = int(request.query_params.get("per_page", "50"))
        except (ValueError, TypeError):
            per_page = 50
        per_page = max(1, min(per_page, 100))
        if state not in ("open", "closed") or not 1 <= page <= 100:
            return Response({"error": "Invalid issue filter."}, status=400)
        connection = get_github_connection(request.user, request.query_params.get("account"))
        token = (connection.extra_data or {}).get("access_token") if connection else None
        if not token:
            token = getattr(settings, "GITHUB_TOKEN", None) or os.getenv("GITHUB_TOKEN")
        headers = {"Accept": "application/vnd.github+json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            search_params = {
                "q": f"repo:{repo} is:issue is:{state}",
                "page": page,
                "per_page": per_page,
                "sort": "updated",
                "order": "desc",
            }
            response = requests.get(
                "https://api.github.com/search/issues",
                headers=headers,
                params=search_params,
                timeout=15,
                allow_redirects=False,
            )
            if response.status_code == 422:
                response = requests.get(
                    f"https://api.github.com/repos/{repo}/issues",
                    headers=headers,
                    params={"state": state, "page": page, "per_page": per_page, "sort": "updated", "direction": "desc"},
                    timeout=15,
                    allow_redirects=False,
                )
            if response.status_code != 200:
                message = "GitHub is temporarily unavailable. Try again later."
                if response.status_code == 404:
                    message = "Repository unavailable. For private repositories, sign in with a GitHub account that has access."
                elif response.status_code == 401:
                    message = "Your GitHub connection has expired. Sign in with GitHub again."
                elif response.status_code in (403, 429):
                    message = "GitHub denied access or its request limit was reached. Try again later."
                return Response({"error": message}, status=502)

            payload = response.json()
            if isinstance(payload, dict):
                raw_items = payload.get("items", [])
                total_count = payload.get("total_count", 0)
                has_next = "next" in response.links or (page * per_page < total_count)
            else:
                raw_items = payload
                has_next = "next" in response.links

            issues = [
                _serialize_issue(repo, item)
                for item in raw_items
                if isinstance(item, dict) and "pull_request" not in item
            ]
            return Response({"repository": repo, "issues": issues, "has_next": has_next})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Issues could not be loaded from GitHub. Try again."}, status=502)


class RepositoryIssueDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid, issue_number=None):
        if issue_number is None:
            try:
                issue_number = int(request.query_params.get("issue_number") or request.query_params.get("number") or 0)
            except (ValueError, TypeError):
                issue_number = 0
        if not issue_number or issue_number <= 0:
            return Response({"error": "Issue number is required."}, status=400)
        repo, headers, error_response = _get_github_repo_context(request.user, sandbox_uuid, request)
        if error_response:
            return error_response
        if not repo:
            return Response({"repository": None, "issue": None})
        try:
            response = requests.get(
                f"https://api.github.com/repos/{repo}/issues/{issue_number}",
                headers=headers,
                timeout=15,
                allow_redirects=False,
            )
            if response.status_code != 200:
                return _handle_github_error(response, "Issue not found.")
            item = response.json()
            if not isinstance(item, dict) or "pull_request" in item:
                return Response({"error": "Issue not found."}, status=404)
            return Response({"repository": repo, "issue": _serialize_issue(repo, item)})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Issue details could not be loaded from GitHub. Try again."}, status=502)


class RepositoryIssueCommentsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, sandbox_uuid, issue_number=None):
        project = _get_accessible_project(request.user, sandbox_uuid)
        if not _has_running_vm(project):
            return _no_vm_response()
        if issue_number is None:
            try:
                issue_number = int(request.query_params.get("issue_number", 0))
            except (ValueError, TypeError):
                issue_number = 0
        if not issue_number or issue_number <= 0:
            return Response({"error": "Issue number is required."}, status=400)
        try:
            repository = read_repository(project, "status", request.query_params.get("path", "/workspace"))
        except RepositoryUnavailable as error:
            return Response({"error": str(error), "code": error.code}, status=404)
        except (ValueError, OSError, subprocess.TimeoutExpired):
            return Response({"error": "Choose a Git repository in this workspace."}, status=400)
        except Exception:
            return Response({"error": "The workspace is temporarily unavailable."}, status=503)
        repo = repository["github_repository"]
        if not repo:
            return Response({"repository": None, "issue_number": issue_number, "comments": []})
        connection = get_github_connection(request.user, request.query_params.get("account"))
        token = (connection.extra_data or {}).get("access_token") if connection else None
        if not token:
            token = getattr(settings, "GITHUB_TOKEN", None) or os.getenv("GITHUB_TOKEN")
        headers = {"Accept": "application/vnd.github+json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            response = requests.get(
                f"https://api.github.com/repos/{repo}/issues/{issue_number}/comments",
                headers=headers,
                params={"per_page": 100},
                timeout=15,
                allow_redirects=False,
            )
            if response.status_code != 200:
                message = "GitHub is temporarily unavailable. Try again later."
                if response.status_code == 404:
                    message = "Comments not found for this issue."
                elif response.status_code == 401:
                    message = "Your GitHub connection has expired. Sign in with GitHub again."
                elif response.status_code in (403, 429):
                    message = "GitHub denied access or its request limit was reached. Try again later."
                return Response({"error": message}, status=502)
            raw_comments = response.json() if isinstance(response.json(), list) else []
            comments = [
                {
                    "id": c.get("id"),
                    "url": c.get("html_url") or "",
                    "author": (c.get("user") or {}).get("login", ""),
                    "author_avatar": (c.get("user") or {}).get("avatar_url", ""),
                    "created_at": c.get("created_at"),
                    "updated_at": c.get("updated_at"),
                    "body": c.get("body") or "",
                }
                for c in raw_comments
                if isinstance(c, dict)
            ]
            return Response({"repository": repo, "issue_number": issue_number, "comments": comments})
        except (requests.RequestException, ValueError, KeyError, TypeError):
            return Response({"error": "Comments could not be loaded from GitHub. Try again."}, status=502)

