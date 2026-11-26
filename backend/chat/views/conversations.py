"""
Conversation CRUD views - list, detail, rename, delete.
"""
import logging
from collections import defaultdict

from django.db.models import F, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

logger = logging.getLogger(__name__)

from chat.constants import ACTIVE_REQUEST_STATUSES
from chat.models import Conversation, Message, Request

from .helpers import coerce_int
from .serializers import maybe_mark_request_timed_out, serialize_request
from mcp.catalog import format_tool_name


def _normalize_tool_calls(tool_calls):
    if not tool_calls:
        return tool_calls
    for tc in tool_calls:
        if isinstance(tc, dict):
            name = tc.get("name") or tc.get("function_name") or (tc.get("function", {}).get("name") if isinstance(tc.get("function"), dict) else "")
            if name and not tc.get("title"):
                tc["title"] = format_tool_name(name)
    return tool_calls


def _normalize_phases(phases):
    if not phases:
        return phases
    for p in phases:
        if isinstance(p, dict):
            name = p.get("toolName")
            if name and not p.get("title"):
                p["title"] = format_tool_name(name)
    return phases


def _accessible_conversations(user):
    return (
        Conversation.objects
        .filter(
            Q(user=user)
            | Q(workspaces__workspace__memberships__user=user)
            | Q(sandboxes__workspace__memberships__user=user)
        )
        .distinct()
    )


def _request_duration_ms(req):
    if not req:
        return None
    if req.duration_seconds is not None:
        return max(0, round(req.duration_seconds * 1000))
    start = req.started_at or req.created_at
    if req.completed_at and start:
        return max(0, round((req.completed_at - start).total_seconds() * 1000))
    return None


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_chat(request, conversation_id):
    """
    Get the complete chat for a conversation, including messages and image parameters.
    """
    conversation = get_object_or_404(_accessible_conversations(request.user), uuid=conversation_id)
    messages = list(
        conversation.messages
        .select_related('parent')
        .prefetch_related('images', 'attachments')
        .defer('search_vector')
        .order_by('created_at')
    )

    # Deduplicate redundant assistant messages for the same parent created during cancellation race conditions
    deduped_messages = []
    for msg in messages:
        if (
            deduped_messages
            and msg.role == 'assistant'
            and deduped_messages[-1].role == 'assistant'
            and msg.parent_id is not None
            and msg.parent_id == deduped_messages[-1].parent_id
        ):
            prev = deduped_messages[-1]
            prev_tools = len(prev.tool_calls or [])
            curr_tools = len(msg.tool_calls or [])
            prev_len = len((prev.content or '') + (prev.thinking or ''))
            curr_len = len((msg.content or '') + (msg.thinking or ''))
            if curr_tools > prev_tools or (curr_tools == prev_tools and curr_len >= prev_len):
                deduped_messages[-1] = msg
        else:
            deduped_messages.append(msg)
    messages = deduped_messages

    active_request = (
        Request.objects
        .filter(conversation=conversation, status__in=ACTIVE_REQUEST_STATUSES)
        .select_related('model', 'conversation', 'parent')
        .order_by('-created_at')
        .first()
    )
    # Resolve lazy timeouts before collecting failed requests, so their saved
    # progress appears in this response rather than disappearing for one poll.
    active_request_data = serialize_request(active_request) if active_request else None
    if active_request_data and active_request_data['status'] not in ACTIVE_REQUEST_STATUSES:
        active_request_data = None

    # Map assistant messages to their corresponding completed/failed request model/tag/error.
    # Requests are linked via parent (user message) and are consumed in chronological order.
    requests_by_parent = defaultdict(list)
    completed_requests = (
        Request.objects
        .filter(conversation=conversation, status__in=['completed', 'failed', 'canceled'], parent__isnull=False)
        .select_related('model', 'parent')
        .order_by('created_at')
    )
    for req in completed_requests:
        parent_uuid = str(req.parent.uuid)
        requests_by_parent[parent_uuid].append(req)

    assigned_request_by_message = {}
    assistant_messages_by_parent = defaultdict(list)
    for msg in messages:
        if msg.role == 'assistant' and msg.parent_id:
            assistant_messages_by_parent[str(msg.parent.uuid)].append(msg)

    virtual_error_messages = []

    for parent_uuid, reqs in requests_by_parent.items():
        assistant_messages = assistant_messages_by_parent.get(parent_uuid, [])
        for idx, req in enumerate(reqs):
            next_request_at = reqs[idx + 1].created_at if idx + 1 < len(reqs) else None
            assistant = next((msg for msg in assistant_messages
                if str(msg.uuid) not in assigned_request_by_message
                and msg.created_at >= req.created_at
                and (next_request_at is None or msg.created_at < next_request_at)), None)
            if assistant:
                assigned_request_by_message[str(assistant.uuid)] = req
            else:
                if req.status == 'failed':
                    virtual_error_messages.append({
                        "parent_uuid": parent_uuid,
                        "request": req
                    })
                elif req.status == 'canceled':
                    partial_state = serialize_request(req)
                    if (
                        partial_state.get("partial_content")
                        or partial_state.get("partial_thinking")
                        or partial_state.get("tool_calls")
                        or partial_state.get("phases")
                    ):
                        virtual_error_messages.append({
                            "parent_uuid": parent_uuid,
                            "request": req,
                            "is_canceled": True,
                        })

    message_list = []
    for msg in messages:
        assigned_request = assigned_request_by_message.get(str(msg.uuid))
        message_model = assigned_request.model.name if assigned_request and assigned_request.model else None
        message_model_display_name = (
            assigned_request.model.display_name
            if assigned_request and assigned_request.model and assigned_request.model.display_name
            else None
        )
        message_duration_ms = _request_duration_ms(assigned_request) if msg.role == 'assistant' else None
        message_tag = None
        message_error = assigned_request.error_message if assigned_request and assigned_request.status == 'failed' else None

        message_list.append({
            "uuid": str(msg.uuid),
            "request_uuid": str(assigned_request.uuid) if assigned_request else None,
            "role": msg.role,
            "content": msg.content,
            "thinking": msg.thinking,
            "thinking_summary": msg.thinking_summary,
            "thinking_segments": msg.thinking_segments,
            "phases": _normalize_phases(msg.phases),
            "type": msg.type,
            "model": message_model,
            "model_display_name": message_model_display_name,
            "duration_ms": message_duration_ms,
            "tag": message_tag,
            "error": message_error,
            "created_at": msg.created_at,
            "parent_uuid": str(msg.parent.uuid) if msg.parent else None,
            "tool_calls": _normalize_tool_calls(msg.tool_calls),
            "file_diff": msg.file_diff,
            "images": [
                {
                    "url": img.image.url,
                    "image_url": img.image.url,
                    "uuid": str(img.uuid),
                    "image_uuid": str(img.uuid),
                    "prompt": img.prompt,
                    "negative_prompt": img.negative_prompt,
                    "width": img.width,
                    "height": img.height,
                    "seed": img.seed,
                    "num_inference_steps": img.num_inference_steps,
                    "guidance_scale": img.guidance_scale,
                    "model": img.model.name if img.model else None,
                    "tag": None,
                    "shared": img.shared,
                }
                for img in msg.images.all()
            ],
            "attachments": [
                {
                    "uuid": str(att.uuid),
                    "url": att.file.url,
                    "name": att.original_name,
                    "content_type": att.content_type,
                    "size": att.file_size,
                }
                for att in msg.attachments.all()
            ],
        })

    for item in virtual_error_messages:
        req = item["request"]
        parent_uuid = item["parent_uuid"]
        partial_state = serialize_request(req)
        is_canceled = item.get("is_canceled") or req.status == 'canceled'
        message_list.append({
            "uuid": f"virtual-{'canceled' if is_canceled else 'failed'}-{req.uuid}",
            "request_uuid": str(req.uuid),
            "role": "assistant",
            "content": partial_state["partial_content"] or "",
            "thinking": partial_state["partial_thinking"],
            "thinking_summary": None,
            "thinking_segments": None,
            "phases": _normalize_phases(partial_state["phases"]) or None,
            "type": "text",
            "model": req.model.name if req.model else None,
            "model_display_name": req.model.display_name if req.model and req.model.display_name else None,
            "duration_ms": _request_duration_ms(req),
            "tag": None,
            "error": None if is_canceled else (req.error_message or "Request failed"),
            "created_at": req.completed_at or req.created_at,
            "parent_uuid": parent_uuid,
            "tool_calls": _normalize_tool_calls(partial_state["tool_calls"]) or None,
            "images": [],
            "attachments": [],
        })

    message_list.sort(key=lambda x: x["created_at"])

    from sandbox.services.conversation_worktree import active_worktree_path
    from sandbox.services.sandbox_service import SandboxBootstrapService

    worktree_path = active_worktree_path(conversation, SandboxBootstrapService.conversation_project(conversation)) or ""
    return Response({
        "conversation": {
            "uuid": str(conversation.uuid),
            "title": conversation.title,
            "created_at": conversation.created_at,
            "worktree_path": worktree_path,
            "messages": message_list,
            "active_request": active_request_data,
        }
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_conversations(request):
    """
    Get a list of all conversations for the authenticated user.
    """
    user = request.user
    limit = coerce_int(request.query_params.get('limit'), 20)
    limit = max(1, min(limit, 100))
    offset = max(0, coerce_int(request.query_params.get('offset'), 0))

    project_uuid = request.query_params.get('project_uuid') or request.query_params.get('workspace_uuid')
    if project_uuid:
        from sandbox.models import Sandbox

        accessible_project = (
            Sandbox.objects
            .filter(uuid=project_uuid)
            .filter(Q(user=user) | Q(workspace__memberships__user=user))
            .distinct()
            .exists()
        )
        if not accessible_project:
            return Response({"error": "Project not found."}, status=status.HTTP_404_NOT_FOUND)
        queryset = Conversation.objects.filter(
            Q(workspaces__uuid=project_uuid) | Q(sandboxes__uuid=project_uuid)
        ).distinct()
    else:
        queryset = Conversation.objects.filter(user=user)
    if request.query_params.get('general_only') == 'true':
        from sandbox.models import Sandbox

        # The /workspace record represents the shared filesystem, not a project.
        # Exclude both current M2M and legacy FK links, including projects outside
        # the selected workspace. Filter before pagination so History stays full.
        projects = Sandbox.objects.exclude(filesystem_path='/workspace')
        assigned = Conversation.objects.filter(
            Q(workspaces__in=projects) | Q(sandboxes__in=projects)
        ).values('pk')
        queryset = queryset.exclude(pk__in=assigned)
    last_user_message = Message.objects.filter(
        conversation_id=OuterRef('pk'), role='user'
    ).order_by('-created_at', '-pk').values('created_at')[:1]
    queryset = queryset.annotate(
        last_activity_at=Coalesce(Subquery(last_user_message), F('created_at'))
    ).prefetch_related('workspaces').order_by('-last_activity_at', '-created_at', '-uuid')
    total = queryset.count()
    window = list(queryset[offset:offset + limit + 1])
    has_next = len(window) > limit
    conversations = window[:limit]
    next_offset = offset + limit if has_next else None

    active_requests = Request.objects.filter(
        conversation__in=conversations,
        status__in=ACTIVE_REQUEST_STATUSES,
    )
    for active_request in active_requests.only(
        'uuid', 'status', 'error_message', 'created_at', 'started_at', 'last_activity_at',
    ):
        maybe_mark_request_timed_out(active_request)
    active_conv_uuids = set(
        str(u) for u in active_requests.values_list('conversation__uuid', flat=True)
    )

    return Response({
        "conversations": [{
            "uuid": str(conv.uuid),
            "title": conv.title,
            "created_at": conv.created_at,
            "last_activity_at": conv.last_activity_at,
            "can_edit": conv.user_id == user.pk,
            "is_generating": str(conv.uuid) in active_conv_uuids,
            "project_ids": [str(project_id) for project_id in conv.workspaces.values_list('uuid', flat=True)],
            "workspace_ids": [str(workspace_id) for workspace_id in conv.workspaces.values_list('uuid', flat=True)],
        } for conv in conversations],
        "has_next": has_next,
        "next_offset": next_offset,
        "total": total,
        "limit": limit,
        "offset": offset,
    })


@api_view(['PATCH'])
@permission_classes([IsAuthenticated])
def rename_conversation(request, conversation_id):
    """
    Rename a conversation.
    """
    conversation = get_object_or_404(Conversation, uuid=conversation_id, user=request.user)
    new_title = request.data.get('title')

    if not new_title or not new_title.strip():
        return Response({"error": "Title is required"}, status=status.HTTP_400_BAD_REQUEST)

    conversation.title = new_title.strip()
    conversation.save(update_fields=['title'])

    return Response({
        "uuid": str(conversation.uuid),
        "title": conversation.title
    })


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def delete_conversation(request, conversation_id):
    """
    Delete a conversation and all its messages.
    """
    conversation = get_object_or_404(Conversation, uuid=conversation_id, user=request.user)
    conversation.delete()

    return Response({"message": "Conversation deleted successfully"}, status=status.HTTP_200_OK)


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def undo_message(request, message_uuid, conversation_id=None):
    """
    Undo a user message: removes the message and all subsequent messages in the conversation,
    restores prompt text, cleans up associated requests, and optionally reverts sandbox git changes.
    """
    if conversation_id:
        conversation = get_object_or_404(_accessible_conversations(request.user), uuid=conversation_id)
        message = get_object_or_404(Message, uuid=message_uuid, conversation=conversation)
    else:
        message = get_object_or_404(Message, uuid=message_uuid)
        conversation = get_object_or_404(_accessible_conversations(request.user), uuid=message.conversation_id)

    if message.role != 'user':
        return Response({"error": "Only user messages can be undone."}, status=status.HTTP_400_BAD_REQUEST)

    # All messages created at or after this message in the conversation
    all_messages = list(conversation.messages.order_by('created_at'))

    delete_ids = {message.pk}
    changed = True
    while changed:
        changed = False
        for m in all_messages:
            if m.parent_id in delete_ids and m.pk not in delete_ids:
                delete_ids.add(m.pk)
                changed = True

    for m in all_messages:
        if m.created_at >= message.created_at:
            delete_ids.add(m.pk)

    target_messages = [m for m in all_messages if m.pk in delete_ids]
    deleted_uuids = [str(m.uuid) for m in target_messages]

    revert_workspace = request.data.get('revert_workspace', True) if isinstance(request.data, dict) else True
    if revert_workspace:
        has_file_changes = any(
            bool(getattr(m, 'file_diff', None) and isinstance(m.file_diff, dict) and m.file_diff.get('has_changes'))
            for m in target_messages
        )
        if has_file_changes:
            sandbox = conversation.workspaces.first() or conversation.sandboxes.first()
            if sandbox:
                from sandbox.services.git_service import SandboxGitService
                from sandbox.services.conversation_worktree import active_worktree_path
                try:
                    SandboxGitService.undo_changes(sandbox, workspace_path=active_worktree_path(conversation, sandbox))
                except Exception as e:
                    logger.warning("Failed to undo git changes for sandbox %s: %s", sandbox.pk, e)

    Request.objects.filter(conversation=conversation, parent_id__in=delete_ids).delete()
    active_reqs = Request.objects.filter(conversation=conversation, status__in=ACTIVE_REQUEST_STATUSES)
    for req in active_reqs:
        if req.parent_id in delete_ids:
            req.status = 'canceled'
            req.save(update_fields=['status'])

    Message.objects.filter(pk__in=delete_ids).delete()

    return Response({
        "ok": True,
        "undone_content": message.content,
        "deleted_uuids": deleted_uuids,
        "message": "Message undone successfully",
    }, status=status.HTTP_200_OK)

