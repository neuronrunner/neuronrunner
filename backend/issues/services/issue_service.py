"""Shared issue operations used by both the REST views and the agent tools."""
from __future__ import annotations

import re
from typing import Any, Iterable

from django.db import transaction
from django.db.models import Count, Max, Q
from django.utils import timezone

from issues.models import Issue, IssueComment

MAX_TITLE = 300
MAX_BODY = 50_000
MAX_COMMENT = 20_000
MAX_LABELS = 20
DEFAULT_PER_PAGE = 50
MAX_PER_PAGE = 100

_HEX_COLOR = re.compile(r"^[0-9a-fA-F]{6}$")


class IssueError(Exception):
    """Validation or permission failure that maps cleanly onto an HTTP status."""

    def __init__(self, message: str, *, status: int = 400, code: str = "invalid"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code

    def as_dict(self) -> dict[str, Any]:
        return {"error": self.message, "code": self.code, "status": self.status}


def _user_name(user) -> str:
    if user is None:
        return ""
    full = getattr(user, "get_full_name", lambda: "")() or ""
    return full.strip() or getattr(user, "username", "") or getattr(user, "email", "") or ""


def clean_title(value: Any) -> str:
    title = " ".join(str(value or "").split())
    if not title:
        raise IssueError("Title is required.", code="title_required")
    if len(title) > MAX_TITLE:
        raise IssueError(f"Title must be at most {MAX_TITLE} characters.", code="title_too_long")
    return title


def clean_body(value: Any) -> str:
    body = str(value or "").replace("\x00", "")
    if len(body) > MAX_BODY:
        raise IssueError(f"Description must be at most {MAX_BODY} characters.", code="body_too_long")
    return body


def clean_comment(value: Any) -> str:
    body = str(value or "").replace("\x00", "").strip()
    if not body:
        raise IssueError("Comment cannot be empty.", code="comment_required")
    if len(body) > MAX_COMMENT:
        raise IssueError(f"Comment must be at most {MAX_COMMENT} characters.", code="comment_too_long")
    return body


def clean_status(value: Any) -> str:
    status = str(value or "").strip()
    if status not in {choice for choice, _ in Issue.STATUS_CHOICES}:
        raise IssueError("Invalid status.", code="invalid_status")
    return status


def clean_priority(value: Any) -> str:
    priority = str(value or "").strip()
    if priority not in {choice for choice, _ in Issue.PRIORITY_CHOICES}:
        raise IssueError("Invalid priority.", code="invalid_priority")
    return priority


def clean_labels(value: Any) -> list[dict[str, str]]:
    if value in (None, ""):
        return []
    if not isinstance(value, (list, tuple)):
        raise IssueError("Labels must be a list.", code="invalid_labels")
    labels: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in value:
        if isinstance(item, str):
            name, color = item, ""
        elif isinstance(item, dict):
            name, color = item.get("name", ""), item.get("color", "")
        else:
            raise IssueError("Each label must be a name or an object.", code="invalid_labels")
        name = " ".join(str(name or "").split())[:50]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        color = str(color or "").lstrip("#")
        labels.append({"name": name, "color": color if _HEX_COLOR.match(color) else ""})
    if len(labels) > MAX_LABELS:
        raise IssueError(f"At most {MAX_LABELS} labels are allowed.", code="too_many_labels")
    return labels


def _apply_status(issue: Issue, status: str) -> None:
    issue.status = status
    if status in Issue.CLOSED_STATUSES:
        issue.closed_at = issue.closed_at or timezone.now()
    else:
        issue.closed_at = None


def _next_number(sandbox) -> int:
    # Serialise number allocation per environment (row lock is a no-op on SQLite).
    type(sandbox).objects.select_for_update().get(pk=sandbox.pk)
    last = Issue.objects.filter(sandbox=sandbox).aggregate(m=Max("number"))["m"] or 0
    return last + 1


def create_issue(
    *,
    sandbox,
    title: Any,
    body: Any = "",
    priority: Any = Issue.PRIORITY_NONE,
    labels: Any = None,
    status: Any = Issue.STATUS_TODO,
    user=None,
    conversation=None,
    creator_type: str = Issue.CREATOR_USER,
    **extra: Any,
) -> Issue:
    fields = {
        "title": clean_title(title),
        "body": clean_body(body),
        "priority": clean_priority(priority),
        "labels": clean_labels(labels),
        "creator_type": creator_type,
        "creator_user": user if getattr(user, "pk", None) else None,
        "source_conversation": conversation,
        **extra,
    }
    clean = clean_status(status)
    with transaction.atomic():
        issue = Issue(sandbox=sandbox, number=_next_number(sandbox), **fields)
        _apply_status(issue, clean)
        issue.save()
    return issue


EDITABLE_FIELDS = ("title", "body", "status", "priority", "labels")
AGENT_EDITABLE_FIELDS = ("status", "branch", "pr_url", "pr_number")


def update_issue(issue: Issue, data: dict[str, Any], *, allowed: Iterable[str] = EDITABLE_FIELDS) -> Issue:
    allowed = set(allowed)
    changed: list[str] = []
    if "title" in data and "title" in allowed:
        issue.title = clean_title(data["title"])
        changed.append("title")
    if "body" in data and "body" in allowed:
        issue.body = clean_body(data["body"])
        changed.append("body")
    if "priority" in data and "priority" in allowed:
        issue.priority = clean_priority(data["priority"])
        changed.append("priority")
    if "labels" in data and "labels" in allowed:
        issue.labels = clean_labels(data["labels"])
        changed.append("labels")
    if "status" in data and "status" in allowed:
        _apply_status(issue, clean_status(data["status"]))
        changed.extend(["status", "closed_at"])
    if "branch" in data and "branch" in allowed:
        issue.branch = str(data["branch"] or "").strip()[:255]
        changed.append("branch")
    if "pr_url" in data and "pr_url" in allowed:
        issue.pr_url = str(data["pr_url"] or "").strip()[:500]
        changed.append("pr_url")
    if "pr_number" in data and "pr_number" in allowed:
        raw = data["pr_number"]
        try:
            issue.pr_number = int(raw) if raw not in (None, "") else None
        except (TypeError, ValueError) as exc:
            raise IssueError("pr_number must be an integer.", code="invalid_pr_number") from exc
        changed.append("pr_number")
    if not changed:
        return issue
    issue.save(update_fields=[*dict.fromkeys(changed), "updated_at"])
    return issue


def add_comment(
    issue: Issue,
    body: Any,
    *,
    user=None,
    author_type: str = IssueComment.AUTHOR_USER,
    author_name: str = "",
    conversation=None,
    external_id: str = "",
) -> IssueComment:
    comment = IssueComment.objects.create(
        issue=issue,
        body=clean_comment(body),
        author_type=author_type,
        author_user=user if getattr(user, "pk", None) else None,
        author_name=(author_name or _user_name(user))[:150],
        conversation=conversation,
        external_id=external_id,
    )
    Issue.objects.filter(pk=issue.pk).update(updated_at=timezone.now())
    return comment


def assign_agent(issue: Issue, conversation, *, user, branch: str = "") -> Issue:
    issue.assigned_to_agent = True
    issue.agent_conversation = conversation
    # Moving an issue forward is fine; never pull one that is already in review back to "in progress".
    if issue.status != Issue.STATUS_IN_REVIEW:
        _apply_status(issue, Issue.STATUS_IN_PROGRESS)
    branch = str(branch or "").strip()[:255]
    if branch:
        issue.branch = branch
    issue.save(
        update_fields=["assigned_to_agent", "agent_conversation", "status", "closed_at", "branch", "updated_at"]
    )
    add_comment(
        issue,
        "Assigned to an agent. A new agent session was started for this issue.",
        user=user,
        author_type=IssueComment.AUTHOR_SYSTEM,
        author_name="System",
        conversation=conversation,
    )
    return issue


def unassign_agent(issue: Issue, *, user) -> Issue:
    issue.assigned_to_agent = False
    issue.agent_conversation = None
    issue.save(update_fields=["assigned_to_agent", "agent_conversation", "updated_at"])
    add_comment(
        issue,
        "Agent unassigned.",
        user=user,
        author_type=IssueComment.AUTHOR_SYSTEM,
        author_name="System",
    )
    return issue


def issue_queryset(sandbox):
    return (
        Issue.objects.filter(sandbox=sandbox)
        .select_related("creator_user", "assignee_user")
        .annotate(comment_count=Count("comments"))
    )


def issue_counts(sandbox) -> dict[str, int]:
    """Open/closed totals for the whole environment (independent of search or paging)."""
    qs = Issue.objects.filter(sandbox=sandbox)
    return {
        "open": qs.filter(status__in=Issue.OPEN_STATUSES).count(),
        "closed": qs.filter(status__in=Issue.CLOSED_STATUSES).count(),
    }


def list_issues(
    sandbox,
    *,
    state: str | None = None,
    status: str | None = None,
    query: str = "",
    page: int = 1,
    per_page: int = DEFAULT_PER_PAGE,
) -> tuple[list[Issue], bool]:
    qs = issue_queryset(sandbox)
    if status:
        qs = qs.filter(status=clean_status(status))
    elif state == "open":
        qs = qs.filter(status__in=Issue.OPEN_STATUSES)
    elif state == "closed":
        qs = qs.filter(status__in=Issue.CLOSED_STATUSES)
    elif state not in (None, "", "all"):
        raise IssueError("Invalid issue filter.", code="invalid_state")
    query = (query or "").strip()
    if query:
        cond = Q(title__icontains=query) | Q(body__icontains=query)
        if query.lstrip("#").isdigit():
            cond |= Q(number=int(query.lstrip("#")))
        qs = qs.filter(cond)
    per_page = max(1, min(int(per_page or DEFAULT_PER_PAGE), MAX_PER_PAGE))
    page = max(1, int(page or 1))
    start = (page - 1) * per_page
    rows = list(qs.order_by("-updated_at", "-number")[start : start + per_page + 1])
    return rows[:per_page], len(rows) > per_page


def serialize_issue(issue: Issue, *, comment_count: int | None = None) -> dict[str, Any]:
    if comment_count is None:
        comment_count = getattr(issue, "comment_count", None)
    if comment_count is None:
        comment_count = issue.comments.count()
    if issue.creator_type == Issue.CREATOR_AGENT:
        creator_name = "Agent"
    elif issue.creator_type == Issue.CREATOR_IMPORT:
        creator_name = issue.external_author or "Imported"
    else:
        creator_name = _user_name(issue.creator_user)
    return {
        "id": str(issue.uuid),
        "number": issue.number,
        "environment_id": str(issue.sandbox_id),
        "title": issue.title,
        "body": issue.body,
        "status": issue.status,
        "state": "open" if issue.is_open else "closed",
        "priority": issue.priority,
        "labels": issue.labels or [],
        "creator": {"type": issue.creator_type, "name": creator_name},
        "assignee": (
            {"id": str(issue.assignee_user_id), "name": _user_name(issue.assignee_user)}
            if issue.assignee_user_id
            else None
        ),
        "assigned_to_agent": issue.assigned_to_agent,
        "agent_conversation_id": str(issue.agent_conversation_id) if issue.agent_conversation_id else None,
        "branch": issue.branch,
        "pr_url": issue.pr_url,
        "pr_number": issue.pr_number,
        "external": (
            {
                "source": issue.external_source,
                "id": issue.external_id,
                "url": issue.external_url,
                "author": issue.external_author,
            }
            if issue.external_source
            else None
        ),
        "comments": comment_count,
        "created_at": issue.created_at.isoformat(),
        "updated_at": issue.updated_at.isoformat(),
        "closed_at": issue.closed_at.isoformat() if issue.closed_at else None,
    }


def serialize_comment(comment: IssueComment) -> dict[str, Any]:
    name = comment.author_name
    if not name:
        name = "Agent" if comment.author_type == IssueComment.AUTHOR_AGENT else _user_name(comment.author_user)
    return {
        "id": str(comment.uuid),
        "author": name,
        "author_type": comment.author_type,
        "body": comment.body,
        "conversation_id": str(comment.conversation_id) if comment.conversation_id else None,
        "created_at": comment.created_at.isoformat(),
        "updated_at": comment.updated_at.isoformat(),
    }
