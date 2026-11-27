"""REST API for native, environment-scoped issues."""
from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.shortcuts import get_object_or_404
from rest_framework import status as http
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from chat.models import Conversation
from issues.models import Issue, IssueComment
from issues.services import importer
from issues.services import issue_service as svc
from issues.services.issue_service import IssueError
from sandbox.models import WorkspaceMembership
from sandbox.views import _get_accessible_project, _is_admin


def _error(exc: IssueError) -> Response:
    return Response({"error": exc.message, "code": exc.code}, status=exc.status)


def _int_param(request, name: str, default: int) -> int:
    try:
        return int(request.query_params.get(name) or default)
    except (TypeError, ValueError):
        return default


def _get_issue(user, sandbox_uuid, number):
    sandbox = _get_accessible_project(user, sandbox_uuid)
    issue = get_object_or_404(svc.issue_queryset(sandbox), number=number)
    return sandbox, issue


def _can_delete(user, sandbox, issue: Issue) -> bool:
    if _is_admin(user) or issue.creator_user_id == user.pk:
        return True
    if not sandbox.workspace_id:
        return sandbox.user_id == user.pk
    return WorkspaceMembership.objects.filter(
        workspace_id=sandbox.workspace_id,
        user=user,
        role__in=(WorkspaceMembership.ROLE_OWNER, WorkspaceMembership.ROLE_ADMIN),
    ).exists()


class EnvironmentIssuesView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, sandbox_uuid):
        sandbox = _get_accessible_project(request.user, sandbox_uuid)
        try:
            rows, has_next = svc.list_issues(
                sandbox,
                state=request.query_params.get("state") or "open",
                status=request.query_params.get("status") or None,
                query=request.query_params.get("q") or "",
                page=_int_param(request, "page", 1),
                per_page=_int_param(request, "per_page", svc.DEFAULT_PER_PAGE),
            )
        except IssueError as exc:
            return _error(exc)
        return Response(
            {
                "environment_id": str(sandbox.uuid),
                "issues": [svc.serialize_issue(row) for row in rows],
                "has_next": has_next,
                "counts": svc.issue_counts(sandbox),
            }
        )

    def post(self, request, sandbox_uuid):
        sandbox = _get_accessible_project(request.user, sandbox_uuid)
        data = request.data
        try:
            issue = svc.create_issue(
                sandbox=sandbox,
                title=data.get("title"),
                body=data.get("body", ""),
                priority=data.get("priority") or Issue.PRIORITY_NONE,
                labels=data.get("labels"),
                status=data.get("status") or Issue.STATUS_TODO,
                user=request.user,
            )
        except IssueError as exc:
            return _error(exc)
        return Response({"issue": svc.serialize_issue(issue, comment_count=0)}, status=http.HTTP_201_CREATED)


class IssueDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, sandbox_uuid, number):
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        return Response({"issue": svc.serialize_issue(issue)})

    def patch(self, request, sandbox_uuid, number):
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        try:
            svc.update_issue(issue, request.data)
        except IssueError as exc:
            return _error(exc)
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        return Response({"issue": svc.serialize_issue(issue)})

    def delete(self, request, sandbox_uuid, number):
        sandbox, issue = _get_issue(request.user, sandbox_uuid, number)
        if not _can_delete(request.user, sandbox, issue):
            return Response(
                {"error": "Only the author or a workspace admin can delete this issue.", "code": "forbidden"},
                status=http.HTTP_403_FORBIDDEN,
            )
        issue.delete()
        return Response(status=http.HTTP_204_NO_CONTENT)


class IssueCommentsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, sandbox_uuid, number):
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        comments = issue.comments.select_related("author_user").order_by("created_at")
        return Response(
            {
                "issue_number": issue.number,
                "comments": [svc.serialize_comment(c) for c in comments],
            }
        )

    def post(self, request, sandbox_uuid, number):
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        try:
            comment = svc.add_comment(issue, request.data.get("body"), user=request.user)
        except IssueError as exc:
            return _error(exc)
        return Response({"comment": svc.serialize_comment(comment)}, status=http.HTTP_201_CREATED)


class IssueAssignAgentView(APIView):
    """Link the agent conversation the UI just started to this issue."""

    permission_classes = [IsAuthenticated]

    def post(self, request, sandbox_uuid, number):
        sandbox, issue = _get_issue(request.user, sandbox_uuid, number)
        conversation_id = request.data.get("conversation_id")
        try:
            conversation = Conversation.objects.filter(pk=conversation_id, user=request.user).first()
        except (DjangoValidationError, ValueError, TypeError):  # malformed UUID
            conversation = None
        bound = bool(
            conversation
            and (
                sandbox.conversation_id == conversation.pk
                or sandbox.conversations.filter(pk=conversation.pk).exists()
            )
        )
        if not bound:
            return Response(
                {"error": "Conversation was not found in this environment.", "code": "conversation_not_found"},
                status=http.HTTP_400_BAD_REQUEST,
            )
        svc.assign_agent(issue, conversation, user=request.user, branch=request.data.get("branch") or "")
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        return Response({"issue": svc.serialize_issue(issue)})


class IssueImportView(APIView):
    """Import issues from the environment's GitHub/GitLab repository (one-off, no sync)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, sandbox_uuid):
        sandbox = _get_accessible_project(request.user, sandbox_uuid)
        try:
            result = importer.import_issues(
                sandbox,
                request.user,
                provider=request.data.get("provider") or None,
                state=request.data.get("state") or "open",
            )
        except IssueError as exc:
            return _error(exc)
        return Response(result.as_dict())


class IssueUnassignAgentView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, sandbox_uuid, number):
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        svc.unassign_agent(issue, user=request.user)
        _, issue = _get_issue(request.user, sandbox_uuid, number)
        return Response({"issue": svc.serialize_issue(issue)})
