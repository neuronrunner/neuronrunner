from rest_framework.exceptions import APIException
from sandbox.services.workspace_auth import resolve_workspace
"""
OpenAI-compatible /v1/chat/completions endpoint.

Drop-in proxy for tools like LM Studio, Open WebUI, Continue.dev, etc.
Reuses predict()'s helpers so request lifecycle is identical.
Does NOT create Message rows — history is taken directly from the request body.
"""
import json
import logging
import time
import uuid

from chat.constants import GENERATION_CANCELED_ERROR
from chat.models import Conversation
from chat.services.utils import async_streaming_response
from chat.views.helpers import coerce_float
from chat.views.predict import (
    _create_request,
    _resolve_model,
    _validate_model_file,
)
from django.http import StreamingHttpResponse
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from model.reasoning import ALLOWED_REASONING_LEVELS, resolve_reasoning_level

from .services.openai_chat_completions import OpenAIChatService

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@api_view(["POST"])
@permission_classes([IsAuthenticated])
def openai_chat_completions(request):
    """
    OpenAI-compatible /v1/chat/completions.

    {
      "model":    "<model_name>",
      "messages": [
        {"role": "system",    "content": "..."},  // optional
        {"role": "user",      "content": "..."},
        {"role": "assistant", "content": "..."},
        {"role": "user",      "content": "..."}   // must be last
      ],
      "temperature": 0.7,
      "top_p": 0.9,
      "stream": false,
      // Neuron Runner extensions (optional):
      "reasoning_level":        "medium",
      "web_search":             false,
      "web_search_max_results": 5
    }
    """
    predict_start = getattr(request, 'timing_start', time.monotonic())
    request._predict_start_time = predict_start

    # Delegate stateful requests (Neuron Runner frontend session, explicit conversation/parent tracking, or file uploads)
    if request.data.get("stateful") or request.data.get("conversation_id") or request.data.get("parent_message_id") or (hasattr(request, 'FILES') and request.FILES):
        from chat.views.openai_completions import _handle_stateful_chat_completions
        return _handle_stateful_chat_completions(request)

    model_id  = request.data.get("model")
    messages  = request.data.get("messages", [])
    do_stream = request.data.get("stream", False) is True

    # Support Responses-style input or content parameter if messages is empty
    if not messages:
        input_param = request.data.get("input") or request.data.get("content")
        if input_param is not None:
            user_content = ""
            if isinstance(input_param, str):
                user_content = input_param
            elif isinstance(input_param, list):
                for item in input_param:
                    if isinstance(item, str):
                        user_content = item
                    elif isinstance(item, dict):
                        content_val = item.get("content")
                        if isinstance(content_val, str):
                            user_content = content_val
                        elif isinstance(content_val, list):
                            for sub in content_val:
                                if isinstance(sub, str):
                                    user_content = sub
                                elif isinstance(sub, dict) and sub.get("type") == "input_text":
                                    user_content = sub.get("text", "")
            elif isinstance(input_param, dict):
                content_val = input_param.get("content")
                if isinstance(content_val, str):
                    user_content = content_val
                elif isinstance(content_val, list):
                    for sub in content_val:
                        if isinstance(sub, str):
                            user_content = sub
                        elif isinstance(sub, dict) and sub.get("type") == "input_text":
                            user_content = sub.get("text", "")

            user_content = user_content.strip()
            messages = [{"role": "user", "content": user_content}]

    # ── Basic validation ─────────────────────────────────────────────────────
    if not model_id:
        return _oai_error("model is required", "invalid_request_error", status.HTTP_400_BAD_REQUEST)

    if not isinstance(messages, list) or not messages:
        return _oai_error("messages or input/content must be provided", "invalid_request_error", status.HTTP_400_BAD_REQUEST)

    try:
        # ── Resolve & validate model ─────────────────────────────────────────
        model_obj = _resolve_model(model_id)
        if isinstance(model_obj, Response):
            return _oai_error(
                model_obj.data.get("message", "Model not found"),
                "invalid_request_error",
                model_obj.status_code,
            )

        if model_obj.model_type == "image":
            return _oai_error(
                "Image generation models are not supported here. Use /predict/ instead.",
                "invalid_request_error",
                status.HTTP_400_BAD_REQUEST,
            )

        file_error = _validate_model_file(model_obj)
        if file_error:
            return _oai_error(
                file_error.data.get("message"),
                "invalid_request_error",
                file_error.status_code,
            )

        # ── Validate message list ────────────────────────────────────────────
        last_msg = messages[-1]
        if last_msg.get("role") not in ("user", "tool"):
            return _oai_error(
                "The last message must be from the user or a tool result.",
                "invalid_request_error",
                status.HTTP_400_BAD_REQUEST,
            )

        user_content = last_msg.get("content") or ""
        if isinstance(user_content, str):
            user_content = user_content.strip()
        if not user_content:
            return _oai_error(
                "Last message has no content",
                "invalid_request_error",
                status.HTTP_400_BAD_REQUEST,
            )

        # ── Minimal DB conversation (for audit trail) ─────────────────────────
        from sandbox.services.provider_keys import ensure_model_usable
        workspace = resolve_workspace(request)
        ensure_model_usable(model_obj, workspace)
        conversation = Conversation.objects.create(user=request.user, workspace=workspace)

        # ── Build params ─────────────────────────────────────────────────────
        params = _build_params(request, model_obj, messages)

        # ── Create DB Request ────────────────────────────────────────────────
        # parent=None because we have no Message rows
        current_request = _create_request(
            model_obj, conversation, request.user,
            None,           # parent
            params,
            do_stream,
        )

        logger.info(
            "openai_chat_completions: request=%s model=%s stream=%s user=%s",
            current_request.uuid, model_obj, do_stream, request.user,
        )

        predict_elapsed = time.monotonic() - request._predict_start_time
        logger.info(f"Time before model request: {predict_elapsed:.3f}s (request_id={current_request.uuid})")
        logger.debug("Pre-model latency: %.3fs (request_id=%s)", predict_elapsed, current_request.uuid)

        # ── Dispatch ─────────────────────────────────────────────────────────
        service = OpenAIChatService(model_obj, conversation, current_request, params, predict_start=request._predict_start_time)

        if do_stream:
            completion_id = f"chatcmpl-{uuid.uuid4().hex}"
            created_ts    = int(time.time())
            return StreamingHttpResponse(
                async_streaming_response(
                    _openai_stream_wrapper(
                        service.generate_streaming(), model_id, completion_id, created_ts
                    )
                ),
                content_type="text/event-stream",
            )

        result = service.generate_sync()
        if result.get("error") == GENERATION_CANCELED_ERROR:
            return _oai_error(result["error"], "server_error", status.HTTP_200_OK)
        if "error" in result:
            return _oai_error(result["error"], "server_error", status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response(_build_sync_response(result, model_id), status=status.HTTP_200_OK)

    except APIException:
        raise
    except ValueError as exc:
        return _oai_error(str(exc), "invalid_request_error", status.HTTP_400_BAD_REQUEST)
    except Exception as exc:
        logger.exception("Unhandled error in openai_chat_completions: %s", exc)
        return _oai_error("Internal server error", "server_error", status.HTTP_500_INTERNAL_SERVER_ERROR)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _build_params(request, model_tag, messages: list) -> dict:
    """Build the params dict expected by OpenAIChatService."""
    reasoning_level_raw = request.data.get("reasoning_level")
    if reasoning_level_raw is None:
        reasoning_level_raw = request.data.get("reasoning_effort")
    reasoning_level = resolve_reasoning_level(
        model_tag,
        reasoning_level_raw,
        allow_default=False,
    )

    return {
        "temperature": coerce_float(request.data.get("temperature", 0.7), 0.7),
        "top_p": coerce_float(request.data.get("top_p", 0.9), 0.9),
        "system_prompt": None,
        "reasoning_level": reasoning_level,
        "attachments_context": "",
        "user_msg": None,
        "messages": messages,
        "tools": request.data.get("tools"),
        "tool_choice": request.data.get("tool_choice", "auto"),
        "chat_mode": request.data.get("chat_mode", "chat"),
    }


def _build_sync_response(result: dict, model_id: str) -> dict:
    """Wrap generate_sync() result in an OpenAI chat.completion object."""
    input_tokens  = result.get("input_tokens", 0)
    output_tokens = result.get("output_tokens", 0)
    tool_calls = result.get("tool_calls")
    if tool_calls:
        oai_tool_calls = []
        for tc in tool_calls:
            oai_tc = {"id": tc.get("id", ""), "type": tc.get("type", "function")}
            if "function" in tc:
                oai_tc["function"] = tc["function"]
            elif "function_name" in tc:
                oai_tc["function"] = {"name": tc["function_name"], "arguments": tc.get("function_arguments", "{}")}
            oai_tool_calls.append(oai_tc)
        message = {"role": "assistant", "content": None, "tool_calls": oai_tool_calls}
        finish_reason = "tool_calls"
    else:
        message = {"role": "assistant", "content": result.get("response", "")}
        finish_reason = "stop"
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_id,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        },
    }


def _openai_stream_wrapper(internal_stream, model_id: str, completion_id: str, created_ts: int):
    """
    Translate internal Neuron Runner SSE events → OpenAI SSE chunks.

    Internal events:
      creating      → ignored
      thinking      → ignored (reasoning not exposed in OAI format)
      message       → forwarded as delta chunk
      complete      → final empty delta + [DONE]
      failed        → error payload + [DONE]
    """
    current_event: str | None = None
    skip_until_tag_close = False

    for raw in internal_stream:
        text = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")
        for line in text.splitlines():
            line = line.rstrip()
            if not line:
                continue

            if line.startswith("event:"):
                current_event = line[len("event:"):].strip()
                continue

            if line.startswith("data:"):
                raw_data = line[len("data:"):].strip()

                if raw_data in ("", "[DONE]"):
                    current_event = None
                    continue

                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError:
                    current_event = None
                    continue

                if current_event == "message":
                    chunk = data.get("v", "")
                    if chunk:
                        if not skip_until_tag_close:
                            if "<" in chunk or "function=" in chunk or "parameter=" in chunk:
                                skip_until_tag_close = True
                                continue
                            yield _openai_chunk(completion_id, created_ts, model_id, chunk)
                        else:
                            if "</function>" in chunk or chunk.endswith("</function>") or chunk.endswith("</parameter>"):
                                skip_until_tag_close = False
                            continue

                elif current_event == "tool_call":
                    yield _openai_tool_call_chunk(completion_id, created_ts, model_id, data)

                elif current_event == "complete":
                    if data.get("tool_calls"):
                        yield _openai_chunk(completion_id, created_ts, model_id, "", finish_reason="tool_calls")
                        yield "data: [DONE]\n\n"
                        return
                    yield _openai_chunk(completion_id, created_ts, model_id, "", finish_reason="stop")
                    yield "data: [DONE]\n\n"
                    return

                elif current_event == "failed":
                    error_msg = data.get("message", "Unknown error")
                    logger.error("Stream failed: %s", error_msg)
                    yield f'data: {json.dumps({"error": {"message": error_msg, "type": "server_error"}})}\n\n'
                    yield "data: [DONE]\n\n"
                    return

                current_event = None

    yield _openai_chunk(completion_id, created_ts, model_id, "", finish_reason="stop")
    yield "data: [DONE]\n\n"


def _openai_chunk(completion_id: str, created_ts: int, model_id: str, content: str, finish_reason=None) -> str:
    payload = {
        "id":      completion_id,
        "object":  "chat.completion.chunk",
        "created": created_ts,
        "model":   model_id,
        "choices": [
            {
                "index": 0,
                "delta": {"content": content} if content else {},
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _openai_tool_call_chunk(completion_id: str, created_ts: int, model_id: str, tool_data: dict) -> str:
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
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _oai_error(message: str, error_type: str, http_status: int) -> Response:
    return Response(
        {"error": {"message": message, "type": error_type}},
        status=http_status,
    )
