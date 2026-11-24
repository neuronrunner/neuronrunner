from rest_framework.exceptions import APIException
import json
import logging
import time
import uuid

from django.http import StreamingHttpResponse
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from chat.constants import GENERATION_CANCELED_ERROR
from chat.services import ChatService
from chat.services.utils import async_streaming_response
from chat.views.predict import (
    _create_message_attachments,
    _create_request,
    _create_user_message,
    _extract_parameters,
    _resolve_model,
    _setup_conversation,
    _validate_model_file,
)

logger = logging.getLogger(__name__)

def _handle_stateful_chat_completions(request, model_id=None):
    """
    Internal handler for stateful OpenAI-compatible chat completions.
    """
    predict_start = getattr(request, 'timing_start', time.monotonic())
    request._predict_start_time = predict_start

    # If model_id is not in URL, get it from request body
    model_name = model_id or request.data.get("model")
    if not model_name:
        return Response({"error": {"message": "model is required", "type": "invalid_request_error"}}, status=status.HTTP_400_BAD_REQUEST)

    # Support raw prompt input format (CLI / legacy tool calling payloads)
    if "prompt" in request.data and "messages" not in request.data:
        raw_prompt = str(request.data.get("prompt") or "").strip()
        if raw_prompt:
            synthesized_messages = []
            if request.data.get("system_prompt"):
                synthesized_messages.append({"role": "system", "content": str(request.data.get("system_prompt"))})
            synthesized_messages.append({"role": "user", "content": raw_prompt})
            mutable = getattr(request.data, "_mutable", False)
            request.data._mutable = True
            request.data["messages"] = synthesized_messages
            request.data._mutable = mutable

    messages_payload = request.data.get("messages", [])
    if not isinstance(messages_payload, list) or not messages_payload:
        return Response({"error": {"message": "messages or input must be provided", "type": "invalid_request_error"}}, status=status.HTTP_400_BAD_REQUEST)

    last_msg = messages_payload[-1]
    if not isinstance(last_msg, dict) or last_msg.get("role") not in ("user", "tool"):
        return Response({"error": {"message": "The last message must be from the user or a tool result.", "type": "invalid_request_error"}}, status=status.HTTP_400_BAD_REQUEST)

    user_content = last_msg.get("content") or ""
    if isinstance(user_content, str):
        user_content = user_content.strip()
    if not user_content:
        return Response({"error": {"message": "Last message has no content", "type": "invalid_request_error"}}, status=status.HTTP_400_BAD_REQUEST)

    stream = request.data.get("stream", False) is True

    try:
        # 1. Resolve and validate model
        model_obj = _resolve_model(model_name)
        if isinstance(model_obj, Response):
            return Response({"error": {"message": model_obj.data.get("message", "Model not found"), "type": "invalid_request_error"}}, status=model_obj.status_code)

        if model_obj.model_type != "text":
            return Response({"error": {"message": f"Model '{model_obj.name}' is not a supported chat model.", "type": "invalid_request_error"}}, status=status.HTTP_400_BAD_REQUEST)

        validation_error = _validate_model_file(model_obj)
        if validation_error:
            return Response({"error": {"message": validation_error.data.get("message"), "type": "invalid_request_error"}}, status=validation_error.status_code)

        # 2. Retrieve conversation and apply rollback/restore if parent_message_id is passed
        conversation, parent_message = _setup_conversation(request)
        if conversation.workspace_id:
            from sandbox.services.provider_keys import ensure_model_usable
            ensure_model_usable(model_obj, conversation.workspace)
            from core.extensions import registry as ext_registry
            ext_registry.quota.ensure_balance(conversation.workspace, model=model_obj, user=request.user)

        # 3. Create database user message
        uploaded_files = request.FILES.getlist('files') if hasattr(request, 'FILES') else []
        attachments_context = ""
        if uploaded_files:
            from chat.services.attachment_service import build_attachment_context
            attachments_context, attachment_names = build_attachment_context(uploaded_files)
            logger.info(
                "Received %s attachment(s) for openai completions request: %s",
                len(attachment_names),
                ', '.join(attachment_names),
            )
            if not user_content or not str(user_content).strip():
                user_content = "Please analyze the attached files."

        user_msg = _create_user_message(conversation, user_content, parent_message)
        if user_msg and uploaded_files:
            _create_message_attachments(user_msg, uploaded_files)

        # 4. Extract parameters and create database Request
        params = _extract_parameters(
            request,
            user_msg=user_msg,
            model_obj=model_obj,
            attachments_context=attachments_context,
            raw_user_content=user_content,
        )
        current_request = _create_request(
            model_obj, conversation, request.user,
            user_msg if user_msg else parent_message,
            params, stream
        )

        logger.info("stateful_openai_chat_completions: request=%s conversation=%s stream=%s", current_request.uuid, conversation.uuid, stream)

        # 5. Initialize stateful ChatService
        service = ChatService(model_obj, conversation, current_request, params, predict_start=predict_start)

        if stream:
            completion_id = f"chatcmpl-{uuid.uuid4().hex}"
            created_ts = int(time.time())
            response = StreamingHttpResponse(
                async_streaming_response(
                    _openai_stateful_stream_wrapper(
                        service.generate_streaming(), model_name, completion_id, created_ts, conversation.uuid, current_request.uuid,
                        user_message_uuid=user_msg.uuid if user_msg else None
                    )
                ),
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
                return Response({"error": {"message": GENERATION_CANCELED_ERROR, "type": "canceled"}}, status=status.HTTP_200_OK)
            if "error" in result:
                return Response({"error": {"message": result["error"], "type": "server_error"}}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

            return Response(_build_stateful_sync_response(result, model_name, conversation.uuid, current_request.uuid), status=status.HTTP_200_OK)

    except APIException:
        raise
    except ValueError as e:
        return Response({"error": {"message": str(e), "type": "invalid_request_error"}}, status=status.HTTP_400_BAD_REQUEST)
    except Exception as e:
        logger.exception("Error in stateful_openai_chat_completions: %s", e)
        return Response({"error": {"message": "Internal server error", "type": "server_error"}}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def stateful_openai_chat_completions(request, model_id=None):
    """
    Public entry point for stateful OpenAI-compatible completions.
    """
    return _handle_stateful_chat_completions(request, model_id=model_id)


def _openai_stateful_stream_wrapper(internal_stream, model_id: str, completion_id: str, created_ts: int, conversation_uuid, request_uuid, user_message_uuid=None):
    """
    Translates internal SSE events -> Standard OpenAI compatible chunks, adding neuronrunner_metadata.
    """
    if user_message_uuid:
        yield _openai_stateful_chunk(
            completion_id, created_ts, model_id, "", conversation_uuid, request_uuid,
            user_message_uuid=user_message_uuid
        )

    current_event: str | None = None

    for raw in internal_stream:
        text = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")
        for line in text.splitlines():
            line = line.rstrip()
            if line.startswith(":"):
                yield f"{line}\n\n"
                continue

            if line.startswith("event:"):
                current_event = line[len("event:"):].strip()
                continue

            if line.startswith("data:"):
                raw_data = line[len("data:"):].strip()
                if raw_data in ("", "[DONE]"):
                    continue

                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError:
                    continue

                if current_event == "message":
                    chunk = data.get("v", "")
                    if chunk:
                        yield _openai_stateful_chunk(completion_id, created_ts, model_id, chunk, conversation_uuid, request_uuid)

                elif current_event == "thinking":
                    chunk = data.get("v", "")
                    if chunk:
                        # Reasoning content chunk (standardized for deepseek/o1 reasoning fields)
                        yield _openai_stateful_chunk(completion_id, created_ts, model_id, "", conversation_uuid, request_uuid, reasoning=chunk)

                elif current_event == "title":
                    yield _openai_stateful_chunk(
                        completion_id, created_ts, model_id, "", conversation_uuid, request_uuid,
                        title=data.get("title")
                    )

                elif current_event == "tool_call":
                    yield _openai_stateful_tool_chunk(completion_id, created_ts, model_id, data, conversation_uuid, request_uuid)

                elif current_event == "tool_result":
                    yield _openai_stateful_tool_result_chunk(completion_id, created_ts, model_id, data, conversation_uuid, request_uuid)
                elif current_event == "tool_output":
                    yield _openai_stateful_tool_result_chunk(completion_id, created_ts, model_id, {"id": data.get("id"), "output": {"stream": data.get("stream"), "text": data.get("text", "")}}, conversation_uuid, request_uuid)

                elif current_event == "complete":
                    # Stream complete: output metadata and [DONE]
                    msg_uuid = data.get("uuid")
                    title = data.get("title")
                    file_diff = data.get("file_diff")

                    yield _openai_stateful_chunk(
                        completion_id, created_ts, model_id, "", conversation_uuid, request_uuid,
                        finish_reason="stop", message_uuid=msg_uuid, title=title, file_diff=file_diff
                    )
                    yield "data: [DONE]\n\n"
                    return

                elif current_event == "failed":
                    error_msg = data.get("message", "Unknown error")
                    yield f'data: {json.dumps({"error": {"message": error_msg, "type": "server_error"}})}\n\n'
                    yield "data: [DONE]\n\n"
                    return


def _openai_stateful_chunk(completion_id: str, created_ts: int, model_id: str, content: str, conversation_uuid, request_uuid, finish_reason=None, reasoning=None, message_uuid=None, user_message_uuid=None, title=None, file_diff=None) -> str:
    delta = {}
    if content:
        delta["content"] = content
    if reasoning:
        delta["reasoning_content"] = reasoning

    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created_ts,
        "model": model_id,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
        "neuronrunner_metadata": {
            "conversation_id": str(conversation_uuid),
            "request_id": str(request_uuid),
            "message_uuid": str(message_uuid) if message_uuid else None,
            "user_message_uuid": str(user_message_uuid) if user_message_uuid else None,
            "title": title,
            "file_diff": file_diff,
        }
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _openai_stateful_tool_chunk(completion_id: str, created_ts: int, model_id: str, tool_data: dict, conversation_uuid, request_uuid) -> str:
    tc_index = tool_data.get("index", 0)
    tool_call = {"index": tc_index}
    if "id" in tool_data:
        tool_call["id"] = tool_data["id"]
    if "type" in tool_data:
        tool_call["type"] = tool_data["type"]

    function = {}
    if "function" in tool_data:
        fn = tool_data["function"]
        if "name" in fn:
            function["name"] = fn["name"]
        if "arguments" in fn:
            function["arguments"] = fn["arguments"]
    if "function_name" in tool_data:
        function["name"] = tool_data["function_name"]
    if "function_arguments" in tool_data:
        function["arguments"] = tool_data["function_arguments"]
    tool_call["function"] = function

    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created_ts,
        "model": model_id,
        "choices": [{
            "index": 0,
            "delta": {"tool_calls": [tool_call]},
            "finish_reason": None,
        }],
        "neuronrunner_metadata": {
            "conversation_id": str(conversation_uuid),
            "request_id": str(request_uuid),
        }
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _build_stateful_sync_response(result: dict, model_id: str, conversation_uuid, request_uuid) -> dict:
    input_tokens = result.get("input_tokens", 0)
    output_tokens = result.get("output_tokens", 0)
    message_uuid = result.get("uuid")

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_id,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": result.get("response", ""),
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        },
        "neuronrunner_metadata": {
            "conversation_id": str(conversation_uuid),
            "request_id": str(request_uuid),
            "message_uuid": str(message_uuid) if message_uuid else None,
            "title": result.get("title"),
            "file_diff": result.get("file_diff"),
        }
    }


def _openai_stateful_tool_result_chunk(completion_id: str, created_ts: int, model_id: str, tool_data: dict, conversation_uuid, request_uuid) -> str:
    tool_call = {
        "id": tool_data.get("id"),
        "result": tool_data.get("result"),
    }
    if "output" in tool_data:
        tool_call["output"] = tool_data["output"]
    if tool_data.get("duration_ms") is not None:
        tool_call["duration_ms"] = tool_data["duration_ms"]
    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created_ts,
        "model": model_id,
        "choices": [{
            "index": 0,
            "delta": {"tool_calls": [tool_call]},
            "finish_reason": None,
        }],
        "neuronrunner_metadata": {
            "conversation_id": str(conversation_uuid),
            "request_id": str(request_uuid),
        }
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
