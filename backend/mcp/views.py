from rest_framework import permissions, status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.response import Response
from rest_framework.exceptions import APIException

from .oauth import revoke_oauth, server_headers
from .errors import connection_error_message
from .models import MCPServer, MCPServerTool, MCPToolExecution
from .serializers import MCPServerSerializer
from .services import discover_tools, execute_tool
from .throttle import MCPGlobalRateThrottle, MCPServerRateThrottle


@api_view(['GET', 'POST'])
@permission_classes([permissions.IsAuthenticated])
def mcp_servers(request):
    if request.method == 'GET':
        servers = MCPServer.objects.filter(user=request.user).prefetch_related('tools')
        serializer = MCPServerSerializer(servers, many=True)
        return Response(serializer.data)

    serializer = MCPServerSerializer(data=request.data, context={'request': request})
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    server = serializer.save()
    return Response(MCPServerSerializer(server).data, status=status.HTTP_201_CREATED)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([permissions.IsAuthenticated])
def mcp_server_detail(request, server_id):
    try:
        server = MCPServer.objects.get(uuid=server_id, user=request.user)
    except MCPServer.DoesNotExist:
        return Response({"error": "MCP server not found"}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response(MCPServerSerializer(server).data)

    if request.method == 'PATCH':
        serializer = MCPServerSerializer(server, data=request.data, partial=True,
                                         context={'request': request})
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        server = serializer.save()
        return Response(MCPServerSerializer(server).data)

    if request.method == 'DELETE':
        if server.auth_type == 'oauth':
            revoke_oauth(server)
        server.delete()
        return Response({"success": True}, status=status.HTTP_200_OK)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def test_mcp_server(request, server_id):
    try:
        server = MCPServer.objects.get(uuid=server_id, user=request.user)
    except MCPServer.DoesNotExist:
        return Response({"error": "MCP server not found"}, status=status.HTTP_404_NOT_FOUND)

    try:
        tools = discover_tools(
            command=server.command,
            url=server.url,
            transport=server.transport,
            env_json=server.env_json,
            http_transport=server.http_transport,
            headers_json=server_headers(server),
            server_uuid=str(server.pk),
            timeout=server.timeout,
            user_uuid=str(request.user.pk),
            workspace_uuid=str(server.workspace_id) if server.workspace_id else None,
        )
        MCPServerSerializer._store_tools(server, tools)
        return Response({
            "success": True,
            "tool_count": len(tools),
            "tools": [{"name": t["name"], "description": t.get("description", "")} for t in tools],
        }, status=status.HTTP_200_OK)
    except APIException:
        raise
    except TimeoutError as exc:
        return Response({"error": connection_error_message(exc), "error_code": "mcp_timeout"}, status=status.HTTP_504_GATEWAY_TIMEOUT)
    except ImportError:
        return Response(
            {"error": "MCP package not installed. Run: pip install mcp"},
            status=status.HTTP_501_NOT_IMPLEMENTED,
        )
    except Exception as e:
        return Response({"error": connection_error_message(e), "error_code": "mcp_connection_failed"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def refresh_tools(request, server_id):
    try:
        server = MCPServer.objects.get(uuid=server_id, user=request.user)
    except MCPServer.DoesNotExist:
        return Response({"error": "MCP server not found"}, status=status.HTTP_404_NOT_FOUND)

    try:
        from .serializers import MCPServerSerializer
        serializer = MCPServerSerializer(context={'request': request})
        serializer._refresh_tools(server, raise_errors=True)

        from .models import MCPServerTool
        tools = list(
            MCPServerTool.objects.filter(server=server)
            .values('name', 'description')
        )
        return Response({
            "success": True,
            "tool_count": len(tools),
            "tools": tools,
        }, status=status.HTTP_200_OK)
    except APIException:
        raise
    except Exception as e:
        return Response({"error": connection_error_message(e), "error_code": "mcp_connection_failed"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
@throttle_classes([MCPServerRateThrottle, MCPGlobalRateThrottle])
def execute_tool_call(request):
    """Execute an MCP tool call. Body: {tool_name, arguments}"""
    tool_name = request.data.get('tool_name', '')
    arguments = request.data.get('arguments', {})

    if not tool_name or not tool_name.startswith('mcp__'):
        return Response({"error": "Invalid tool_name. Must start with 'mcp__'"}, status=status.HTTP_400_BAD_REQUEST)

    parts = tool_name[5:].split('__', 1)
    if len(parts) != 2:
        return Response({"error": "Malformed tool name"}, status=status.HTTP_400_BAD_REQUEST)
    server_name, actual_tool = parts

    server = MCPServer.objects.filter(
        user=request.user, name=server_name, enabled=True
    ).first()
    if not server:
        return Response({"error": f"MCP server not found: {server_name}"}, status=status.HTTP_404_NOT_FOUND)

    if not MCPServerTool.objects.filter(server=server, name=actual_tool).exists():
        return Response({"error": f"Tool {actual_tool} not found on server {server_name}"}, status=status.HTTP_404_NOT_FOUND)

    try:
        result, duration_ms = execute_tool(
            transport=server.transport,
            command=server.command,
            url=server.url,
            env_json=server.env_json,
            http_transport=server.http_transport,
            headers_json=server_headers(server),
            tool_name=actual_tool,
            arguments=arguments,
            timeout=server.timeout,
            server_uuid=str(server.uuid),
            user_uuid=str(request.user.uuid),
            workspace_uuid=str(server.workspace_id) if server.workspace_id else None,
        )
        MCPToolExecution.objects.create(
            server=server,
            tool_name=actual_tool,
            user=request.user,
            arguments=arguments,
            result=result,
            duration_ms=duration_ms,
            success=True,
        )
        return Response({"success": True, "result": result}, status=status.HTTP_200_OK)
    except APIException:
        raise
    except TimeoutError:
        MCPToolExecution.objects.create(
            server=server,
            tool_name=actual_tool,
            user=request.user,
            arguments=arguments,
            error="Tool execution timed out",
            duration_ms=server.timeout * 1000,
            success=False,
        )
        return Response({"error": "Tool execution timed out"}, status=status.HTTP_504_GATEWAY_TIMEOUT)
    except Exception as e:
        MCPToolExecution.objects.create(
            server=server,
            tool_name=actual_tool,
            user=request.user,
            arguments=arguments,
            error=connection_error_message(e),
            duration_ms=0,
            success=False,
        )
        return Response({"error": connection_error_message(e), "error_code": "mcp_connection_failed"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def list_all_tools(request):
    """List all MCP tools across all enabled servers for the current user."""
    from django.db.models import Q
    tools = list(
        MCPServerTool.objects.filter(server__user=request.user, server__enabled=True)
        .filter(Q(server__transport='http') | Q(server__workspace__memberships__user=request.user))
        .select_related('server')
        .values('server__name', 'name', 'description')
        .order_by('server__name', 'name')
    )

    result = []
    for t in tools:
        tool_name = f"mcp__{t['server__name']}__{t['name']}"
        result.append({
            "name": tool_name,
            "server": t['server__name'],
            "description": t['description'],
        })

    return Response(result, status=status.HTTP_200_OK)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def list_executions(request):
    """List MCP tool executions for the current user."""
    server_id = request.query_params.get('server')

    queryset = MCPToolExecution.objects.filter(user=request.user).select_related('server')

    if server_id:
        queryset = queryset.filter(server_id=server_id)

    executions = list(
        queryset
        .values('uuid', 'server__name', 'tool_name', 'arguments', 'result', 'error', 'duration_ms', 'success', 'created_at')
        .order_by('-created_at')[:100]
    )

    result = []
    for e in executions:
        result.append({
            "uuid": e['uuid'],
            "server": e['server__name'],
            "tool_name": e['tool_name'],
            "arguments": e['arguments'],
            "result": e['result'],
            "error": e['error'],
            "duration_ms": e['duration_ms'],
            "success": e['success'],
            "created_at": e['created_at'].isoformat() if hasattr(e['created_at'], 'isoformat') else e['created_at'],
        })

    return Response(result, status=status.HTTP_200_OK)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def get_execution(request, execution_id):
    """Get a specific MCP tool execution."""
    try:
        execution = MCPToolExecution.objects.select_related('server').get(
            uuid=execution_id, user=request.user
        )
    except MCPToolExecution.DoesNotExist:
        return Response({"error": "Execution not found"}, status=status.HTTP_404_NOT_FOUND)

    return Response({
        "uuid": str(execution.uuid),
        "server": execution.server.name,
        "tool_name": execution.tool_name,
        "arguments": execution.arguments,
        "result": execution.result,
        "error": execution.error,
        "duration_ms": execution.duration_ms,
        "success": execution.success,
        "created_at": execution.created_at.isoformat(),
    }, status=status.HTTP_200_OK)
