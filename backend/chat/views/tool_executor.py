"""
Execute a built-in tool call from the model.
The frontend calls this when it receives a tool_call SSE event for a built-in tool.
"""
import json

from rest_framework import permissions, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from ..builtin_tools import execute_builtin_tool
from ..services.utils import async_streaming_response


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def execute_tool(request):
    """Execute a built-in tool and return the result.

    Body: { name: str, arguments: dict, conversation_id?: str }
    """
    tool_name = request.data.get('name', '').strip()
    arguments = request.data.get('arguments', {})
    if not isinstance(arguments, dict):
        try:
            arguments = json.loads(arguments) if isinstance(arguments, str) else {}
        except (json.JSONDecodeError, TypeError):
            arguments = {}

    if not tool_name:
        return Response({"error": "name is required"}, status=status.HTTP_400_BAD_REQUEST)

    conversation = None
    conversation_id = request.data.get("conversation_id")
    if conversation_id:
        from uuid import UUID
        from django.db.models import Q
        from django.shortcuts import get_object_or_404
        from chat.models import Conversation
        try:
            conversation_uuid = UUID(str(conversation_id))
        except (ValueError, TypeError):
            return Response({"error": "Invalid conversation_id"}, status=status.HTTP_400_BAD_REQUEST)
        conversation = get_object_or_404(
            Conversation.objects.filter(
                Q(user=request.user) | Q(workspaces__workspace__memberships__user=request.user)
            ).distinct(),
            uuid=conversation_uuid,
        )
    result = execute_builtin_tool(request.user, tool_name, arguments, conversation=conversation)
    try:
        result_data = json.loads(result)
    except (json.JSONDecodeError, TypeError):
        result_data = {"result": result}

    return Response({"tool": tool_name, "result": result_data})


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def execute_tool_stream(request):
    """Execute a sandbox command and stream the stdout/stderr in real-time as SSE.

    Body: { command: str, sandbox_uuid: str, cwd: str }
    """
    import logging
    import shlex

    from django.http import StreamingHttpResponse
    from django.db.models import Q
    from sandbox.models import Sandbox
    from sandbox.services.sandbox_session import get_sandbox_manager

    from chat.services.utils import sse_event

    logger = logging.getLogger(__name__)

    command = request.data.get('command', '').strip()
    sandbox_uuid = request.data.get('sandbox_uuid', '').strip()
    cwd = request.data.get('cwd', '').strip()

    if not command:
        return Response({"error": "command is required"}, status=status.HTTP_400_BAD_REQUEST)
    if not sandbox_uuid:
        return Response({"error": "sandbox_uuid is required"}, status=status.HTTP_400_BAD_REQUEST)

    try:
        sandbox_obj = (
            Sandbox.objects
            .filter(uuid=sandbox_uuid)
            .filter(Q(user=request.user) | Q(workspace__memberships__user=request.user))
            .distinct()
            .get()
        )
    except Sandbox.DoesNotExist:
        return Response({"error": "Sandbox not found"}, status=status.HTTP_404_NOT_FOUND)

    sandbox_manager = get_sandbox_manager()
    runtime_name = request.META.get('HTTP_X_SANDBOX_RUNTIME') or ''
    sandbox = sandbox_manager.get_or_create(sandbox_obj, runtime=runtime_name)

    # Construct the sequential command to yield output and exit code
    full_cmd = f"cd {shlex.quote(cwd)} && {command} 2>&1; EXIT_CODE=$?; echo \"___CWD___:$(pwd)\"; echo \"___EXIT___:$EXIT_CODE\""

    def event_stream():
        exec_timeout = int(request.data.get("timeout") or 300)
        exec_timeout = max(5, min(1800, exec_timeout))

        try:
            try:
                process = sandbox.exec("stdbuf", "-oL", "-eL", "bash", "-lc", full_cmd, timeout=exec_timeout)
            except Exception as exc:
                if "not found" in str(exc).lower() or "terminated" in str(exc).lower() or "dead" in str(exc).lower():
                    logger.warning("Sandbox %s was dead on exec, recreating...", sandbox_uuid)
                    new_sandbox = sandbox_manager.get_or_create(sandbox_obj, runtime=runtime_name)
                    process = new_sandbox.exec("stdbuf", "-oL", "-eL", "bash", "-lc", full_cmd, timeout=exec_timeout)
                else:
                    raise exc

            next_cwd = cwd
            exit_code = 0
            current_line = ""
            yielded_in_current_line = 0

            def is_marker_line_or_prefix(s):
                markers = ["___CWD___:", "___EXIT___:"]
                for m in markers:
                    if m.startswith(s) or s.startswith(m):
                        return True
                return False

            for chunk in process.stdout:
                if not chunk:
                    continue
                if isinstance(chunk, bytes):
                    text = chunk.decode('utf-8', errors='replace')
                else:
                    text = chunk

                current_line += text
                lines = current_line.split("\n")

                if len(lines) > 1:
                    for line in lines[:-1]:
                        # Check for markers
                        if line.startswith("___CWD___:"):
                            rawPath = line[len("___CWD___:"):].strip()
                            if rawPath == "/workspace" or rawPath == "/workspace/":
                                next_cwd = "."
                            elif rawPath.startswith("/workspace/"):
                                next_cwd = rawPath[len("/workspace/"):]
                            else:
                                next_cwd = rawPath
                        elif line.startswith("___EXIT___:"):
                            try:
                                exit_code = int(line[len("___EXIT___:"):].strip())
                            except ValueError:
                                exit_code = 0
                        else:
                            to_yield = line[yielded_in_current_line:] + "\n"
                            if to_yield:
                                yield sse_event('output', {"text": to_yield})
                        yielded_in_current_line = 0

                    current_line = lines[-1]
                    yielded_in_current_line = 0

                if current_line:
                    if not is_marker_line_or_prefix(current_line):
                        to_yield = current_line[yielded_in_current_line:]
                        if to_yield:
                            yield sse_event('output', {"text": to_yield})
                        yielded_in_current_line = len(current_line)

            # Process remaining buffer
            if current_line:
                if current_line.startswith("___CWD___:"):
                    rawPath = current_line[len("___CWD___:"):].strip()
                    if rawPath == "/workspace" or rawPath == "/workspace/":
                        next_cwd = "."
                    elif rawPath.startswith("/workspace/"):
                        next_cwd = rawPath[len("/workspace/"):]
                    else:
                        next_cwd = rawPath
                elif current_line.startswith("___EXIT___:"):
                    try:
                        exit_code = int(current_line[len("___EXIT___:"):].strip())
                    except ValueError:
                        exit_code = 0
                else:
                    to_yield = current_line[yielded_in_current_line:]
                    if to_yield:
                        yield sse_event('output', {"text": to_yield})

            process.wait()
            # Yield exit summary
            yield sse_event('exit', {"cwd": next_cwd, "code": exit_code})

            # update status
            sandbox_manager.update_activity(str(sandbox_obj.uuid))
        except Exception as e:
            logger.exception("Streaming execution failed")
            yield sse_event('error', {"message": str(e)})

    response = StreamingHttpResponse(async_streaming_response(event_stream()), content_type="text/event-stream")
    response['X-Accel-Buffering'] = 'no'
    response['Cache-Control'] = 'no-cache'
    return response
