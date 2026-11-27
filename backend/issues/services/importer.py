"""One-off import of issues from the environment's GitHub or GitLab repository (no ongoing sync)."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import quote, urlsplit

import requests
from django.conf import settings
from django.db import IntegrityError
from social_django.models import UserSocialAuth

from issues.models import Issue
from issues.services import issue_service as svc
from issues.services.issue_service import IssueError

logger = logging.getLogger(__name__)

PROVIDERS = (Issue.SOURCE_GITHUB, Issue.SOURCE_GITLAB)
MAX_IMPORT = 500
PER_PAGE = 100
REQUEST_TIMEOUT = 20
GITHUB_API = "https://api.github.com"


@dataclass
class ImportResult:
    provider: str
    imported: int = 0
    skipped: int = 0
    truncated: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "imported": self.imported,
            "skipped": self.skipped,
            "truncated": self.truncated,
        }


def _gitlab_base_url() -> str:
    return (getattr(settings, "GITLAB_BASE_URL", None) or os.getenv("GITLAB_BASE_URL", "https://gitlab.com")).strip().rstrip("/")


def _repo_parts(sandbox) -> tuple[str, str]:
    """Return (host, project path) for the environment's repository."""
    host, path = "", ""
    url = (sandbox.repo_url or "").strip()
    if url:
        if url.startswith("git@") and ":" in url:
            host, path = url[4:].split(":", 1)
        else:
            parts = urlsplit(url)
            host, path = (parts.hostname or ""), parts.path
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    return host.lower(), path or (sandbox.repo_full_name or "").strip("/")


def detect_provider(sandbox) -> str | None:
    host, _ = _repo_parts(sandbox)
    if host == "github.com":
        return Issue.SOURCE_GITHUB
    if host and (host == (urlsplit(_gitlab_base_url()).hostname or "").lower() or host.startswith("gitlab.")):
        return Issue.SOURCE_GITLAB
    if not host and sandbox.repo_full_name:
        return Issue.SOURCE_GITHUB
    return None


def _github_token(user) -> str | None:
    from authentication.github_connection import get_github_connection

    connection = get_github_connection(user)
    return ((connection.extra_data or {}).get("access_token") if connection else None) or None


def _gitlab_token(user) -> str | None:
    connection = UserSocialAuth.objects.filter(user=user, provider="gitlab").order_by("-id").first()
    if connection is None:
        return None
    try:
        from authentication import gitlab_connection

        refresh = getattr(gitlab_connection, "fresh_gitlab_token", None)
        if refresh:
            return refresh(connection) or None
    except Exception:  # token refresh must never take the import down
        logger.warning("GitLab token refresh failed", exc_info=True)
    return (connection.extra_data or {}).get("access_token") or None


def _parse_time(value: Any):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _get(url: str, *, headers: dict[str, str], params: dict[str, Any]) -> requests.Response:
    try:
        return requests.get(url, headers=headers, params=params, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        logger.warning("Issue import request failed: %s", exc)
        raise IssueError("The issue provider could not be reached. Try again.", status=502, code="provider_unreachable") from exc


# ── Providers: each yields normalised dicts, newest first, and flags whether more pages exist ────────────

def _github_items(user, path: str, state: str):
    token = _github_token(user)
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    page = 1
    while True:
        response = _get(
            f"{GITHUB_API}/repos/{path}/issues",
            headers=headers,
            params={"state": state, "per_page": PER_PAGE, "page": page, "sort": "created", "direction": "desc"},
        )
        if response.status_code in (401, 403, 404):
            if response.status_code == 403 and response.headers.get("X-RateLimit-Remaining") == "0":
                raise IssueError("GitHub rate limit reached. Try again later.", status=502, code="rate_limited")
            if not token:
                raise IssueError(
                    "Connect your GitHub account to import issues from this repository.",
                    code="github_not_connected",
                )
            raise IssueError(
                "This repository's issues are not accessible with your GitHub account.", status=400, code="repository_unavailable"
            )
        if response.status_code == 429:
            raise IssueError("GitHub rate limit reached. Try again later.", status=502, code="rate_limited")
        if response.status_code != 200:
            raise IssueError("Issues could not be loaded from GitHub. Try again.", status=502, code="provider_error")
        payload = response.json()
        if not isinstance(payload, list):
            raise IssueError("Issues could not be loaded from GitHub. Try again.", status=502, code="provider_error")
        for item in payload:
            if not isinstance(item, dict) or "pull_request" in item:  # the issues API also lists PRs
                continue
            closed = item.get("state") == "closed"
            yield {
                "external_id": str(item.get("number")),
                "title": item.get("title") or f"Issue #{item.get('number')}",
                "body": item.get("body") or "",
                "status": (
                    Issue.STATUS_CANCELLED
                    if closed and item.get("state_reason") == "not_planned"
                    else Issue.STATUS_DONE
                    if closed
                    else Issue.STATUS_TODO
                ),
                "labels": [
                    {"name": label.get("name", ""), "color": label.get("color", "")}
                    for label in item.get("labels") or []
                    if isinstance(label, dict)
                ],
                "url": item.get("html_url") or "",
                "author": ((item.get("user") or {}).get("login")) or "",
                "created_at": _parse_time(item.get("created_at")),
                "updated_at": _parse_time(item.get("updated_at")),
                "closed_at": _parse_time(item.get("closed_at")),
            }
        has_next = 'rel="next"' in (response.headers.get("Link") or "") or len(payload) >= PER_PAGE
        if not payload or not has_next:
            return
        page += 1


def _gitlab_items(user, path: str, state: str):
    token = _gitlab_token(user)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    gitlab_state = {"open": "opened", "closed": "closed"}.get(state, "all")
    page = 1
    while True:
        response = _get(
            f"{_gitlab_base_url()}/api/v4/projects/{quote(path, safe='')}/issues",
            headers=headers,
            params={
                "state": gitlab_state,
                "per_page": PER_PAGE,
                "page": page,
                "order_by": "created_at",
                "sort": "desc",
                "scope": "all",
            },
        )
        if response.status_code in (401, 403):
            if not token:
                raise IssueError(
                    "Connect your GitLab account to import issues from this repository.", code="gitlab_not_connected"
                )
            raise IssueError(
                "GitLab denied access to the issues. Reconnect GitLab and allow API read access.",
                status=400,
                code="gitlab_scope_missing",
            )
        if response.status_code == 404:
            raise IssueError(
                "This repository's issues are not accessible with your GitLab account.", status=400, code="repository_unavailable"
            )
        if response.status_code == 429:
            raise IssueError("GitLab rate limit reached. Try again later.", status=502, code="rate_limited")
        if response.status_code != 200:
            raise IssueError("Issues could not be loaded from GitLab. Try again.", status=502, code="provider_error")
        payload = response.json()
        if not isinstance(payload, list):
            raise IssueError("Issues could not be loaded from GitLab. Try again.", status=502, code="provider_error")
        for item in payload:
            if not isinstance(item, dict):
                continue
            closed = item.get("state") == "closed"
            yield {
                "external_id": str(item.get("iid")),
                "title": item.get("title") or f"Issue #{item.get('iid')}",
                "body": item.get("description") or "",
                "status": Issue.STATUS_DONE if closed else Issue.STATUS_TODO,
                "labels": [{"name": str(name), "color": ""} for name in item.get("labels") or []],
                "url": item.get("web_url") or "",
                "author": ((item.get("author") or {}).get("username")) or "",
                "created_at": _parse_time(item.get("created_at")),
                "updated_at": _parse_time(item.get("updated_at")),
                "closed_at": _parse_time(item.get("closed_at")),
            }
        has_next = bool(response.headers.get("X-Next-Page")) or len(payload) >= PER_PAGE
        if not payload or not has_next:
            return
        page += 1


_FETCHERS = {Issue.SOURCE_GITHUB: _github_items, Issue.SOURCE_GITLAB: _gitlab_items}


def import_issues(sandbox, user, *, provider: str | None = None, state: str = "open") -> ImportResult:
    if state not in ("open", "closed", "all"):
        raise IssueError("Invalid issue filter.", code="invalid_state")
    provider = provider or detect_provider(sandbox)
    if provider not in PROVIDERS:
        raise IssueError(
            "This environment has no GitHub or GitLab repository to import issues from.", code="no_repository"
        )
    _, path = _repo_parts(sandbox)
    if not path:
        raise IssueError("This environment has no repository to import issues from.", code="no_repository")

    result = ImportResult(provider=provider)
    existing = set(
        Issue.objects.filter(sandbox=sandbox, external_source=provider).values_list("external_id", flat=True)
    )
    fresh: list[dict[str, Any]] = []
    seen = 0
    for item in _FETCHERS[provider](user, path, state):
        if seen >= MAX_IMPORT:
            result.truncated = True
            break
        seen += 1
        if item["external_id"] in existing:
            result.skipped += 1
        else:
            fresh.append(item)
            existing.add(item["external_id"])

    # Oldest first so the native numbers follow the original chronology.
    fresh.sort(key=lambda item: (item["created_at"] is None, item["created_at"] or datetime.min))
    for item in fresh:
        try:
            issue = svc.create_issue(
                sandbox=sandbox,
                title=(item["title"].strip() or f"Issue #{item['external_id']}")[: svc.MAX_TITLE],
                body=item["body"][: svc.MAX_BODY],
                labels=item["labels"][: svc.MAX_LABELS],
                status=item["status"],
                creator_type=Issue.CREATOR_IMPORT,
                external_source=provider,
                external_id=item["external_id"],
                external_url=item["url"][:500],
                external_author=item["author"][:150],
            )
        except IntegrityError:  # imported concurrently by someone else
            result.skipped += 1
            continue
        stamps = {
            name: item[name]
            for name in ("created_at", "updated_at", "closed_at")
            if item.get(name) is not None and (name != "closed_at" or issue.status in Issue.CLOSED_STATUSES)
        }
        if stamps:
            Issue.objects.filter(pk=issue.pk).update(**stamps)
        result.imported += 1
    return result
