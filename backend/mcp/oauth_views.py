from uuid import UUID

from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from .models import MCPServer, MCPOAuthAttempt
from .oauth import OAuthError, client_metadata, complete_oauth, start_oauth
from .serializers import MCPServerSerializer


class OAuthStartThrottle(UserRateThrottle):
    rate = '20/hour'
    scope = 'mcp_oauth_start'


@api_view(['GET'])
@permission_classes([permissions.AllowAny])
def metadata(request):
    response = JsonResponse(client_metadata(request))
    response['Cache-Control'] = 'public, max-age=3600'
    return response


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
@throttle_classes([OAuthStartThrottle])
def start(request, server_id):
    server = MCPServer.objects.filter(pk=server_id, user=request.user).first()
    if not server:
        return Response({'error': 'MCP server not found'}, status=status.HTTP_404_NOT_FOUND)
    response = Response(start_oauth(server, request))
    response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def complete(request):
    server = complete_oauth(request)
    # A token exchange alone is not a verified MCP connection.
    with transaction.atomic():
        current = MCPServer.objects.select_for_update().filter(pk=server.pk).first()
        if not current or current.url != server.url or current.auth_type != 'oauth':
            raise OAuthError('This connector changed during authorization. Connect again.')
        serializer = MCPServerSerializer(context={'request': request})
        serializer._refresh_tools(current, raise_errors=True)
        current.enabled = True
        current.save(update_fields=['enabled', 'updated_at'])
        server = current
    response = Response(MCPServerSerializer(server).data)
    response['Cache-Control'] = 'no-store'
    return response


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def connection_status(request, server_id):
    try:
        attempt_id = UUID(request.query_params.get('attempt', ''))
    except (ValueError, TypeError, AttributeError):
        return Response({'error': 'Invalid OAuth connection'}, status=400)
    attempt = MCPOAuthAttempt.objects.select_related('server').filter(
        pk=attempt_id, server_id=server_id, server__user=request.user,
    ).first() if request.query_params.get('attempt') else None
    if not attempt:
        return Response({'error': 'OAuth connection not found'}, status=status.HTTP_404_NOT_FOUND)
    try:
        config = attempt.server.oauth_json
    except ValueError:
        config = {}
    connected = config.get('attempt_id') == str(attempt.pk) and attempt.server.enabled
    response = Response({'status': 'connected' if connected else 'expired' if attempt.expires_at <= timezone.now() else 'pending',
                         **({'server': MCPServerSerializer(attempt.server).data} if connected else {})})
    response['Cache-Control'] = 'no-store'
    return response
