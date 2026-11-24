from rest_framework.exceptions import APIException
"""
Predict endpoint - entry point for text chat (streaming and non-streaming).
"""
import logging
import os
import time
import uuid
from decimal import Decimal

from django.http import StreamingHttpResponse
from django.db.models import Q
from django.utils import timezone
from model.models import Model
from model.reasoning import ALLOWED_REASONING_LEVELS, resolve_reasoning_level
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from chat.constants import GENERATION_CANCELED_ERROR
from chat.models import Conversation, Message, MessageAttachment, Request
from chat.services import ChatService
from chat.services.attachment_service import build_attachment_context
from chat.services.utils import async_streaming_response

from .helpers import coerce_float

logger = logging.getLogger(__name__)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def predict(request, model_id):
    """
    Predict endpoint for text chat (streaming and non-streaming).
    """
    predict_start = getattr(request, 'timing_start', time.monotonic())
    logger.info(f"Predict endpoint called with model_id: {model_id}")
    stream = request.query_params.get('stream', 'false').lower() == 'true'
    logger.info(f"Predict called (stream={stream}) for {model_id}, user={request.user}")
    request._predict_start_time = predict_start

    try:
        uploaded_files = request.FILES.getlist('files') if hasattr(request, 'FILES') else []

        # Setup conversation and messages
        conversation, parent_message = _setup_conversation(request)

        from core.extensions import registry as ext_registry, resolve_workspace_hook
        workspace = resolve_workspace_hook(request, conversation=conversation)

        # Resolve model (checking workspace models first)
        model_obj = _resolve_model(model_id, workspace=workspace)
        if isinstance(model_obj, Response):
            return model_obj

        from sandbox.services.provider_keys import ensure_model_usable
        ensure_model_usable(model_obj, workspace)
        ext_registry.quota.ensure_balance(workspace, model=model_obj, user=request.user)
        conversation.workspace = workspace
        conversation.save(update_fields=['workspace'])

        if model_obj.model_type != 'text':
            return Response(
                {"message": f"Model '{model_obj.name}' is not a supported chat model."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate model weights exist for non-external models
        validation_error = _validate_model_file(model_obj)
        if validation_error:
            return validation_error

        logger.info(f"Found model: {model_obj.name}")

        # Create user message
        user_content = request.data.get('content')
        attachments_context = ''

        if uploaded_files:
            attachments_context, attachment_names = build_attachment_context(uploaded_files)
            logger.info(
                "Received %s attachment(s) for predict request: %s",
                len(attachment_names),
                ', '.join(attachment_names),
            )
            if not user_content or not str(user_content).strip():
                user_content = "Please analyze the attached files."

        user_msg = _create_user_message(
            conversation,
            user_content,
            parent_message,
        )

        if user_msg is None and not user_content and not parent_message:
            parent_message_id_raw = request.data.get('parent_message_id')
            if not parent_message_id_raw:
                return Response({"message": "content or prompt required"}, status=status.HTTP_400_BAD_REQUEST)

        if user_msg and uploaded_files:
            _create_message_attachments(user_msg, uploaded_files)

        # Extract parameters and create request
        params = _extract_parameters(
            request,
            user_msg,
            model_obj,
            attachments_context=attachments_context,
        )
        current_request = _create_request(
            model_obj, conversation, request.user,
            user_msg if user_msg else parent_message,
            params, stream
        )

        logger.info(f"Created request {current_request.uuid} for {model_obj.name} (stream={stream})")

        service = ChatService(model_obj, conversation, current_request, params, predict_start=request._predict_start_time)

        # Execute based on streaming preference
        if stream:
            response = StreamingHttpResponse(
                async_streaming_response(service.generate_streaming()),
                content_type='text/event-stream'
            )
            response['X-Request-ID'] = str(current_request.uuid)
            response['X-Conversation-ID'] = str(conversation.uuid)
            response['Cache-Control'] = 'no-cache'
            response['X-Accel-Buffering'] = 'no'
            return response
        else:
            result = service.generate_sync()
            if result.get("error") == GENERATION_CANCELED_ERROR:
                return Response({"message": GENERATION_CANCELED_ERROR, "status": "canceled"}, status=status.HTTP_200_OK)
            if "error" in result:
                return Response({"message": result["error"]}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
            return Response({
                "message": "Request completed successfully",
                **result
            }, status=status.HTTP_200_OK)

    except APIException:
        raise
    except ValueError as e:
        return Response({"message": str(e)}, status=status.HTTP_400_BAD_REQUEST)
    except Exception as e:
        logger.exception(f"Error in predict endpoint: {str(e)}")
        return Response({"message": "Internal server error"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _resolve_model(model_id: str, workspace=None):
    """Resolve model_id to a Model object, checking workspace custom models first."""
    model_name = model_id.split(':', 1)[0] if ':' in model_id else model_id
    if model_name in ('deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash') and not Model.objects.filter(name=model_name).exists():
        model_name = 'deepseek-v4.1-flash-1017'
    try:
        model_obj = Model.objects.select_related('llm_config').get(name=model_name)
        ws_id = getattr(model_obj, 'workspace_id', None)
        if ws_id and workspace and str(ws_id) != str(workspace.pk):
            ws_model = Model.objects.filter(workspace=workspace, name=model_name).select_related('llm_config').first()
            if ws_model:
                return ws_model
        return model_obj
    except Model.DoesNotExist:
        logger.error(f"Model not found: {model_name}")
        return Response(
            {"message": f"Model '{model_name}' not found"},
            status=status.HTTP_404_NOT_FOUND
        )


def _validate_model_file(model_obj) -> Response | None:
    """Validate that non-external models have an associated storage path."""
    if getattr(model_obj, "is_external", False) or getattr(model_obj, "source", "") == Model.SOURCE_EXTERNAL:
        return None
    if getattr(model_obj, "storage_path", ""):
        return None
    return Response(
        {"message": f"Model '{model_obj.name}' has no associated weights or storage path"},
        status=status.HTTP_400_BAD_REQUEST
    )


def _setup_conversation(request) -> tuple:
    """Setup or retrieve conversation and parent message."""
    conversation = None
    conversation_param = request.data.get('conversation_id') or request.data.get('conversation')
    conversation_id = None
    if isinstance(conversation_param, dict):
        conversation_id = conversation_param.get("id")
    elif isinstance(conversation_param, str):
        conversation_id = conversation_param

    if conversation_id:
        try:
            conversation_uuid = uuid.UUID(str(conversation_id))
            conversation = (
                Conversation.objects
                .filter(uuid=conversation_uuid)
                .filter(
                    Q(user=request.user)
                    | Q(workspace__memberships__user=request.user)
                    | Q(workspaces__workspace__memberships__user=request.user)
                )
                .distinct()
                .first()
            )
        except (ValueError, AttributeError):
            logger.warning(f"Ignoring invalid conversation_id '{conversation_id}'")
    if not conversation:
        conversation = Conversation.objects.create(user=request.user)

    from core.extensions import registry as ext_registry, resolve_workspace_hook
    workspace = resolve_workspace_hook(request, conversation=conversation)
    conversation.workspace = workspace
    update_fields = ['workspace']
    from sandbox.services.runtime_provider import uses_docker
    if uses_docker():
        # Self-hosted: tools of this conversation run in the runtime picked in the UI.
        from sandbox.services.sandbox_session import coerce_runtime_name
        conversation.runtime_name = coerce_runtime_name(
            request.data.get('vm_uuid') or getattr(request, 'META', {}).get('HTTP_X_SANDBOX_RUNTIME')
        ) or ''
        update_fields.append('runtime_name')
    conversation.save(update_fields=update_fields)

    project_uuid = request.data.get('project_uuid') or request.data.get('workspace_uuid')
    if project_uuid:
        from sandbox.models import Sandbox

        project = (
            Sandbox.objects
            .filter(uuid=project_uuid)
            .filter(Q(user=request.user) | Q(workspace__memberships__user=request.user))
            .distinct()
            .first()
        )
        if project:
            project.conversations.add(conversation)
            # Keep the legacy single-conversation field populated for older clients.
            if not project.conversation_id:
                project.conversation = conversation
                project.save(update_fields=['conversation', 'updated_at'])
            ext_registry.runtime.attach_request_runtime(request, workspace, project)

    parent_message_id = request.data.get('parent_message_id') or request.data.get('parent')
    parent_message = _resolve_parent_message(conversation, parent_message_id)

    return conversation, parent_message


def _resolve_parent_message(conversation, parent_message_id) -> Message | None:
    """Resolve a client-supplied parent id to a persisted message.

    The UI reuses the request UUID as the UUID of a failed/canceled assistant
    message, and may also send client-only placeholders such as
    ``virtual-failed-<request_uuid>`` or ``error-<timestamp>``. Treating those
    as unknown used to create the follow-up message with ``parent=None``, which
    silently dropped the whole conversation history on "continue".
    """
    if not parent_message_id:
        return None

    raw_id = str(parent_message_id).strip()
    for prefix in ("virtual-failed-", "virtual-canceled-"):
        if raw_id.startswith(prefix):
            raw_id = raw_id[len(prefix):]
            break

    try:
        identifier = uuid.UUID(raw_id)
    except (ValueError, AttributeError):
        identifier = None

    if identifier is not None:
        message = (
            Message.objects
            .defer('search_vector')
            .filter(uuid=identifier, conversation=conversation)
            .first()
        )
        if message:
            return message

        # Failed/canceled attempts are exposed to the client under the request
        # UUID. Continue from the assistant reply saved for that attempt when
        # available (keeps partial tool evidence), otherwise from its prompt.
        failed_request = Request.objects.filter(uuid=identifier, conversation=conversation).first()
        if failed_request:
            return _request_attempt_message(conversation, failed_request) or failed_request.parent

    # Client-only placeholder (e.g. "error-<timestamp>") or a stale id: fall
    # back to the latest persisted message so history is never discarded.
    latest = (
        Message.objects
        .defer('search_vector')
        .filter(conversation=conversation)
        .order_by('-created_at', '-pk')
        .first()
    )
    if latest:
        logger.warning(
            "Unresolved parent_message_id '%s' for conversation %s; continuing from latest message %s",
            parent_message_id, conversation.uuid, latest.uuid,
        )
    return latest


def _request_attempt_message(conversation, request_obj) -> Message | None:
    """Return the assistant message produced by a specific request attempt."""
    if not request_obj.parent_id:
        return None
    next_request = (
        Request.objects
        .filter(conversation=conversation, parent_id=request_obj.parent_id, created_at__gt=request_obj.created_at)
        .order_by('created_at')
        .first()
    )
    candidates = Message.objects.defer('search_vector').filter(
        conversation=conversation,
        role='assistant',
        parent_id=request_obj.parent_id,
        created_at__gte=request_obj.created_at,
    )
    if next_request:
        candidates = candidates.filter(created_at__lt=next_request.created_at)
    return candidates.order_by('created_at').first()


def _create_user_message(conversation, content, parent_message) -> Message | None:
    """Create user message if content is provided."""
    if not content:
        return None
    if isinstance(content, list):
        texts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                texts.append(part.get("text", ""))
            elif isinstance(part, str):
                texts.append(part)
        text_content = " ".join(filter(None, texts)).strip()
        if not text_content:
            text_content = "Please analyze the attached files / images."
    else:
        text_content = str(content).strip()

    if text_content:
        return Message.objects.create(
            conversation=conversation,
            content=text_content,
            role='user',
            parent=parent_message
        )
    return None


def _create_message_attachments(user_msg: Message, uploaded_files) -> None:
    """Persist uploaded files so chat UI can list and download them later."""
    for uploaded_file in uploaded_files:
        MessageAttachment.objects.create(
            message=user_msg,
            file=uploaded_file,
            original_name=str(getattr(uploaded_file, 'name', '') or 'attachment'),
            content_type=getattr(uploaded_file, 'content_type', None),
            file_size=int(getattr(uploaded_file, 'size', 0) or 0),
        )

    # Sync uploaded files to workspace VM disk at /workspace/.uploads/
    try:
        from sandbox.services.sandbox_service import SandboxBootstrapService
        project = SandboxBootstrapService.conversation_project(user_msg.conversation)
        if project:
            from sandbox.services.volume_tools import shared_workspace_project, write_file
            target_project = shared_workspace_project(project)
            for uploaded_file in uploaded_files:
                raw_name = str(getattr(uploaded_file, 'name', '') or 'attachment')
                name = os.path.basename(raw_name) or 'attachment'
                dest = f"/workspace/.uploads/{name}"
                content = uploaded_file.read()
                uploaded_file.seek(0)
                write_file(target_project, dest, content)
    except Exception as exc:
        logger.warning("Could not sync uploaded files to workspace .uploads/: %s", exc)


def _extract_parameters(
    request,
    user_msg=None,
    model_obj=None,
    attachments_context: str = '',
    **kwargs,
) -> dict:
    """Extract parameters from request."""
    if user_msg is None and 'user_msg' in kwargs:
        user_msg = kwargs['user_msg']
    if model_obj is None and 'model_obj' in kwargs:
        model_obj = kwargs['model_obj']
    if not attachments_context and 'attachments_context' in kwargs:
        attachments_context = kwargs['attachments_context']

    raw_reasoning = request.data.get('reasoning_level')
    reasoning_level = resolve_reasoning_level(
        model_obj,
        raw_reasoning,
        allow_default=('reasoning_level' not in request.data or raw_reasoning not in (None, '')),
    )

    return {
        'temperature': coerce_float(request.data.get('temperature', 0.7), 0.7),
        'top_p': coerce_float(request.data.get('top_p', 0.9), 0.9),
        'system_prompt': request.data.get('system_prompt'),
        'reasoning_level': reasoning_level,
        'attachments_context': attachments_context,
        'user_msg': user_msg,
        'raw_user_content': kwargs.get('raw_user_content') or request.data.get('raw_user_content'),
        'chat_mode': request.data.get('chat_mode', 'chat'),
        'tools': request.data.get('tools'),
        'tool_choice': request.data.get('tool_choice'),
    }


def _create_request(model_obj, conversation, user, parent, params: dict, stream: bool) -> Request:
    """Create a Request object in the database."""
    from sandbox.services.workspace_auth import personal_workspace
    from sandbox.services.provider_keys import ensure_model_usable, provider_for_model
    workspace = conversation.workspace or personal_workspace(user)
    ensure_model_usable(model_obj, workspace)
    provider = provider_for_model(model_obj, workspace_id=workspace.pk) if model_obj.is_external else None
    uses_byok = bool(provider and workspace.provider_keys.filter(provider=provider).exists())
    if model_obj.is_external and model_obj.model_type == 'text' and not uses_byok:
        from model.services_pricing import ensure_model_pricing
        ensure_model_pricing(model_obj)
    now = timezone.now()
    return Request.objects.create(
        model=model_obj,
        status='processing' if stream else 'pending',
        conversation=conversation,
        user=user,
        parent=parent,
        temperature=params.get('temperature'),
        top_p=params.get('top_p'),
        system_prompt=params.get('system_prompt'),
        reasoning_level=params.get('reasoning_level'),
        started_at=now if stream else None,
        workspace=workspace,
        uses_byok=uses_byok,
        provider=provider or '',
        pricing_model_snapshot='token',
        input_price_snapshot=model_obj.input_price,
        output_price_snapshot=model_obj.output_price,
        cache_read_price_snapshot=model_obj.cache_read_price if model_obj.cache_read_price is not None else model_obj.input_price,
        price_per_hour_snapshot=None,
    )
