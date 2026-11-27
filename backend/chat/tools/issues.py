"""Agent tools for the environment's native issue tracker.

Scope always comes from the conversation (``_conversation_id`` is injected by the executor and cannot be set by
the model), so an agent only ever sees the issues of the environment its conversation is bound to.
"""
import logging

from django.db.models import Q

from . import register

logger = logging.getLogger(__name__)

MAX_LIST = 50
MAX_COMMENTS_IN_GET = 20
# Humans decide when an issue is finished; agents can only report progress.
AGENT_STATUSES = ("in_progress", "in_review")

_NUMBER = {"type": "integer", "description": "Issue number (the #N shown in the tracker)."}

ISSUE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "issue_list",
            "description": "List issues in this environment's tracker. Use it to check for duplicates before creating one.",
            "parameters": {
                "type": "object",
                "properties": {
                    "state": {"type": "string", "enum": ["open", "closed", "all"], "description": "Default open."},
                    "query": {"type": "string", "description": "Match against title, description or #number."},
                    "limit": {"type": "integer", "description": f"Max results (default 20, at most {MAX_LIST})."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "issue_get",
            "description": "Read one issue with its description and recent comments.",
            "parameters": {"type": "object", "properties": {"number": _NUMBER}, "required": ["number"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "issue_create",
            "description": (
                "Open a new issue in this environment's tracker, e.g. for a separate bug or follow-up you found "
                "while working. It is not assigned to anyone; a person decides who works on it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short summary (max 300 characters)."},
                    "body": {"type": "string", "description": "Markdown description with steps, context and expected result."},
                    "priority": {"type": "string", "enum": ["none", "low", "medium", "high", "urgent"]},
                    "labels": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "issue_comment",
            "description": "Add a comment to an issue (progress notes, findings, questions that need a human decision).",
            "parameters": {
                "type": "object",
                "properties": {
                    "number": {**_NUMBER, "description": "Issue number. Defaults to the issue assigned to this conversation."},
                    "body": {"type": "string", "description": "Markdown comment."},
                },
                "required": ["body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "issue_update",
            "description": (
                "Report progress on the issue assigned to this conversation: set its status to in_progress or "
                "in_review and record the branch and pull request. You cannot close issues or edit other issues."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": list(AGENT_STATUSES)},
                    "branch": {"type": "string", "description": "Branch containing the work."},
                    "pr_url": {"type": "string", "description": "URL of the pull request."},
                    "pr_number": {"type": "integer", "description": "Pull request number."},
                },
            },
        },
    },
]

ISSUE_TOOL_NAMES = tuple(tool["function"]["name"] for tool in ISSUE_TOOLS)


def _context(user, arguments):
    """Return (conversation, sandbox) for the calling conversation, or an error dict."""
    conversation_id = arguments.get("_conversation_id")
    if not conversation_id:
        return {"error": "Issue tools need an active conversation."}
    from chat.models import Conversation
    from sandbox.models import Sandbox
    from sandbox.services.sandbox_service import SandboxBootstrapService

    conversation = Conversation.objects.filter(pk=conversation_id).first()
    if not conversation:
        return {"error": "Conversation not found."}
    sandbox = SandboxBootstrapService.conversation_project(conversation)
    if not sandbox:
        return {"error": "This conversation is not bound to an environment, so it has no issue tracker."}
    allowed = Sandbox.objects.filter(pk=sandbox.pk).filter(
        Q(workspace__isnull=True, user=user) | Q(workspace__memberships__user=user)
    )
    if not allowed.exists():
        return {"error": "The environment is not available for this user."}
    return conversation, sandbox


def _get(sandbox, number):
    from issues.services import issue_service as svc

    try:
        number = int(number)
    except (TypeError, ValueError):
        return None
    return svc.issue_queryset(sandbox).filter(number=number).first()


def _brief(issue):
    from issues.services import issue_service as svc

    data = svc.serialize_issue(issue)
    return {
        "number": data["number"],
        "title": data["title"],
        "status": data["status"],
        "priority": data["priority"],
        "labels": [label["name"] for label in data["labels"]],
        "assigned_to_agent": data["assigned_to_agent"],
        "branch": data["branch"],
        "pr_url": data["pr_url"],
        "comments": data["comments"],
    }


def _guarded(handler):
    def wrapper(user, arguments):
        from issues.services.issue_service import IssueError

        ctx = _context(user, arguments)
        if isinstance(ctx, dict):
            return ctx
        try:
            return handler(user, arguments, *ctx)
        except IssueError as exc:
            return exc.as_dict()

    return wrapper


@_guarded
def handle_list(user, arguments, conversation, sandbox):
    from issues.services import issue_service as svc

    try:
        limit = max(1, min(int(arguments.get("limit") or 20), MAX_LIST))
    except (TypeError, ValueError):
        limit = 20
    rows, has_next = svc.list_issues(
        sandbox,
        state=arguments.get("state") or "open",
        query=arguments.get("query") or "",
        per_page=limit,
    )
    return {"issues": [_brief(row) for row in rows], "has_more": has_next}


@_guarded
def handle_get(user, arguments, conversation, sandbox):
    from issues.services import issue_service as svc

    issue = _get(sandbox, arguments.get("number"))
    if not issue:
        return {"error": "Issue not found in this environment."}
    comments = list(issue.comments.order_by("-created_at")[:MAX_COMMENTS_IN_GET])[::-1]
    return {"issue": svc.serialize_issue(issue), "comments": [svc.serialize_comment(c) for c in comments]}


@_guarded
def handle_create(user, arguments, conversation, sandbox):
    from issues.models import Issue
    from issues.services import issue_service as svc

    issue = svc.create_issue(
        sandbox=sandbox,
        title=arguments.get("title"),
        body=arguments.get("body", ""),
        priority=arguments.get("priority") or Issue.PRIORITY_NONE,
        labels=arguments.get("labels"),
        user=None,
        conversation=conversation,
        creator_type=Issue.CREATOR_AGENT,
    )
    return {"created": True, "number": issue.number, "title": issue.title}


def _linked_issue(sandbox, conversation):
    from issues.models import Issue

    return Issue.objects.filter(sandbox=sandbox, agent_conversation=conversation).first()


@_guarded
def handle_comment(user, arguments, conversation, sandbox):
    from issues.models import IssueComment
    from issues.services import issue_service as svc

    if arguments.get("number") in (None, ""):
        issue = _linked_issue(sandbox, conversation)
        if not issue:
            return {"error": "No issue is assigned to this conversation; pass the issue number."}
    else:
        issue = _get(sandbox, arguments.get("number"))
        if not issue:
            return {"error": "Issue not found in this environment."}
    comment = svc.add_comment(
        issue,
        arguments.get("body"),
        author_type=IssueComment.AUTHOR_AGENT,
        author_name="Agent",
        conversation=conversation,
    )
    return {"commented": True, "number": issue.number, "comment_id": str(comment.uuid)}


@_guarded
def handle_update(user, arguments, conversation, sandbox):
    from issues.services import issue_service as svc
    from issues.services.issue_service import IssueError

    issue = _linked_issue(sandbox, conversation)
    if not issue:
        return {
            "error": "No issue is assigned to this conversation. Agents can only update the issue they were "
            "assigned; use issue_comment or issue_create instead."
        }
    requested = arguments.get("number")
    if requested not in (None, "") and str(requested) != str(issue.number):
        return {"error": f"This conversation is assigned to issue #{issue.number} and cannot update #{requested}."}
    data = {key: arguments[key] for key in ("status", "branch", "pr_url", "pr_number") if key in arguments}
    if "status" in data and data["status"] not in AGENT_STATUSES:
        raise IssueError(
            f"Agents can set the status to {' or '.join(AGENT_STATUSES)}; ask a person to close the issue.",
            code="invalid_status",
        )
    if not data:
        return {"error": "Nothing to update: pass status, branch, pr_url or pr_number."}
    svc.update_issue(issue, data, allowed=svc.AGENT_EDITABLE_FIELDS)
    issue.refresh_from_db()
    return {"updated": True, **_brief(issue)}


register("issue_list", handle_list)
register("issue_get", handle_get)
register("issue_create", handle_create)
register("issue_comment", handle_comment)
register("issue_update", handle_update)
