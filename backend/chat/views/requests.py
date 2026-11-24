from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from utils.cache import set_request_cancelled

from chat.constants import GENERATION_CANCELED_ERROR
from chat.models import Request as RequestModel

from .serializers import serialize_request


def _request_queryset(user):
    return RequestModel.objects.filter(user=user).select_related(
        'model',
        'conversation',
        'parent',
    ).prefetch_related(
        'parent__children__images',
    )


def _apply_filters(queryset, request):
    date_from = request.query_params.get('from')
    date_to = request.query_params.get('to')
    conversation_id = request.query_params.get('conversation_id')
    statuses_param = request.query_params.get('statuses')

    if date_from:
        queryset = queryset.filter(created_at__gte=date_from)
    if date_to:
        queryset = queryset.filter(created_at__lte=date_to)
    if conversation_id:
        queryset = queryset.filter(conversation__uuid=conversation_id)
    if statuses_param:
        statuses = [item.strip() for item in statuses_param.split(',') if item.strip()]
        if statuses:
            queryset = queryset.filter(status__in=statuses)

    return queryset

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def list_requests(request):
    try:
        limit = max(1, min(int(request.query_params.get('limit', 20)), 100))
        offset = max(0, int(request.query_params.get('offset', 0)))
    except (ValueError, TypeError):
        return Response({"error": "Invalid pagination params"}, status=400)

    from sandbox.services.workspace_auth import resolve_workspace
    workspace = resolve_workspace(request)
    base_qs = _apply_filters(RequestModel.objects.filter(workspace=workspace).select_related('model', 'conversation', 'parent').prefetch_related('parent__children__images'), request)
    total = base_qs.count()

    user_requests = (
        base_qs
        .order_by('-created_at')
        .only(
            'uuid', 'created_at', 'started_at', 'completed_at',
            'status', 'error_message',
            'partial_content', 'partial_thinking',
            'cost', 'pricing_model_snapshot',
            'input_tokens', 'output_tokens', 'duration_seconds',
            'model__name', 'model__model_type',
            'conversation__uuid', 'parent__uuid',
        )
        [offset:offset + limit]
    )

    return Response({
        "requests": [serialize_request(req) for req in user_requests],
        "total": total,
        "limit": limit,
        "offset": offset,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_request(request, request_id):
    req = get_object_or_404(_request_queryset(request.user), uuid=request_id)
    return Response({"request": serialize_request(req)})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def cancel_request(request, request_id):
    req = get_object_or_404(_request_queryset(request.user), uuid=request_id)

    if req.status == 'completed':
        return Response({"message": "Request already completed", "request": serialize_request(req)}, status=200)

    if req.status == 'canceled' or (req.status == 'failed' and req.error_message == GENERATION_CANCELED_ERROR):
        return Response({
            "message": "Generation already canceled",
            "request": serialize_request(req),
        }, status=200)

    if req.status == 'failed':
        return Response({"message": "Request already finalized", "request": serialize_request(req)}, status=200)

    client_content = request.data.get('content')
    client_thinking = request.data.get('thinking')
    client_tool_calls = request.data.get('tool_calls')
    client_phases = request.data.get('phases')

    update_fields = ['status', 'error_message', 'completed_at']
    if client_content:
        req.partial_content = client_content
        update_fields.append('partial_content')
    if client_thinking:
        req.partial_thinking = client_thinking
        update_fields.append('partial_thinking')
    if client_tool_calls:
        req.partial_tool_calls = client_tool_calls
        update_fields.append('partial_tool_calls')
    if client_phases:
        req.partial_phases = client_phases
        update_fields.append('partial_phases')

    req.status = 'canceled'
    req.error_message = GENERATION_CANCELED_ERROR
    req.completed_at = req.completed_at or timezone.now()
    req.save(update_fields=update_fields)

    content_to_save = req.partial_content or ""
    thinking_to_save = req.partial_thinking or None
    tool_calls_to_save = req.partial_tool_calls or None
    phases_to_save = req.partial_phases or None

    if (content_to_save or thinking_to_save or tool_calls_to_save or phases_to_save) and req.parent:
        from chat.models import Message
        from django.db import transaction
        with transaction.atomic():
            existing_msg = (
                Message.objects
                .select_for_update()
                .filter(conversation=req.conversation, role='assistant', parent=req.parent)
                .order_by('-created_at')
                .first()
            )

            if existing_msg:
                update_fields = []
                if content_to_save and not existing_msg.content:
                    existing_msg.content = content_to_save
                    update_fields.append('content')
                if thinking_to_save and not existing_msg.thinking:
                    existing_msg.thinking = thinking_to_save
                    update_fields.append('thinking')
                if phases_to_save and (not existing_msg.phases or len(phases_to_save) > len(existing_msg.phases)):
                    existing_msg.phases = phases_to_save
                    update_fields.append('phases')
                if tool_calls_to_save and (not existing_msg.tool_calls or len(tool_calls_to_save) > len(existing_msg.tool_calls)):
                    existing_msg.tool_calls = tool_calls_to_save
                    update_fields.append('tool_calls')
                if update_fields:
                    existing_msg.save(update_fields=update_fields)
            else:
                Message.objects.create(
                    conversation=req.conversation,
                    role='assistant',
                    content=content_to_save,
                    thinking=thinking_to_save,
                    phases=phases_to_save,
                    tool_calls=tool_calls_to_save,
                    parent=req.parent,
                )

    set_request_cancelled(str(req.uuid))

    return Response({
        "message": "Generation canceled",
        "request": serialize_request(req),
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def cancel_conversation_active_request(request, conversation_id):
    """Cancel any pending or processing requests in this conversation."""
    from chat.models import Conversation, Message
    conversation = get_object_or_404(Conversation.objects.filter(user=request.user), uuid=conversation_id)
    active_requests = RequestModel.objects.filter(
        conversation=conversation,
        user=request.user,
        status__in=['pending', 'processing']
    )
    canceled_ids = []
    now = timezone.now()

    client_content = request.data.get('content')
    client_thinking = request.data.get('thinking')
    client_tool_calls = request.data.get('tool_calls')
    client_phases = request.data.get('phases')

    for req in active_requests:
        update_fields = ['status', 'error_message', 'completed_at']
        if client_content and not req.partial_content:
            req.partial_content = client_content
            update_fields.append('partial_content')
        if client_thinking and not req.partial_thinking:
            req.partial_thinking = client_thinking
            update_fields.append('partial_thinking')
        if client_tool_calls and not req.partial_tool_calls:
            req.partial_tool_calls = client_tool_calls
            update_fields.append('partial_tool_calls')
        if client_phases and not req.partial_phases:
            req.partial_phases = client_phases
            update_fields.append('partial_phases')

        req.status = 'canceled'
        req.error_message = GENERATION_CANCELED_ERROR
        req.completed_at = req.completed_at or now
        req.save(update_fields=update_fields)
        set_request_cancelled(str(req.uuid))
        canceled_ids.append(str(req.uuid))

        content_to_save = req.partial_content or ""
        thinking_to_save = req.partial_thinking or None
        tool_calls_to_save = req.partial_tool_calls or None
        phases_to_save = req.partial_phases or None

        if (content_to_save or thinking_to_save or tool_calls_to_save or phases_to_save) and req.parent:
            from django.db import transaction
            with transaction.atomic():
                existing_msg = (
                    Message.objects
                    .select_for_update()
                    .filter(conversation=conversation, role='assistant', parent=req.parent)
                    .order_by('-created_at')
                    .first()
                )
                if existing_msg:
                    update_fields = []
                    if content_to_save and not existing_msg.content:
                        existing_msg.content = content_to_save
                        update_fields.append('content')
                    if thinking_to_save and not existing_msg.thinking:
                        existing_msg.thinking = thinking_to_save
                        update_fields.append('thinking')
                    if phases_to_save and (not existing_msg.phases or len(phases_to_save) > len(existing_msg.phases)):
                        existing_msg.phases = phases_to_save
                        update_fields.append('phases')
                    if tool_calls_to_save and (not existing_msg.tool_calls or len(tool_calls_to_save) > len(existing_msg.tool_calls)):
                        existing_msg.tool_calls = tool_calls_to_save
                        update_fields.append('tool_calls')
                    if update_fields:
                        existing_msg.save(update_fields=update_fields)
                else:
                    Message.objects.create(
                        conversation=conversation,
                        role='assistant',
                        content=content_to_save,
                        thinking=thinking_to_save,
                        phases=phases_to_save,
                        tool_calls=tool_calls_to_save,
                        parent=req.parent,
                    )

    return Response({
        "message": "Generation canceled",
        "canceled_request_ids": canceled_ids,
    })

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_request_stats(request):
    """Get aggregated statistics about the user's requests."""
    user_requests = RequestModel.objects.filter(user=request.user)

    date_from = request.query_params.get('from')
    date_to = request.query_params.get('to')

    if date_from:
        user_requests = user_requests.filter(created_at__gte=date_from)
    if date_to:
        user_requests = user_requests.filter(created_at__lte=date_to)

    total_duration = sum(req.duration_seconds for req in user_requests if req.duration_seconds)
    total_credits_used = sum(req.cost for req in user_requests if req.cost)
    total_input_tokens = sum(req.input_tokens for req in user_requests if req.input_tokens)
    total_output_tokens = sum(req.output_tokens for req in user_requests if req.output_tokens)

    return Response({
        "total_duration": total_duration,
        "total_cost_usd": total_credits_used,
        "total_cost": total_credits_used,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
    })
