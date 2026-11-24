"""Authenticated management endpoints; application traffic stays off the API origin."""
import logging
from urllib.parse import urlsplit

from rest_framework import permissions, serializers
from rest_framework.exceptions import APIException
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from .services.port_preview import create_port_preview, listening_ports, close_port_preview, SYSTEM_PORTS
from .views import _get_accessible_project

logger = logging.getLogger(__name__)


class PortPreviewRequest(serializers.Serializer):
    port = serializers.IntegerField(min_value=1, max_value=65535)
    path = serializers.CharField(default="/", max_length=4096, trim_whitespace=False)

    def validate_port(self, value):
        if value in SYSTEM_PORTS:
            raise serializers.ValidationError(f"Port {value} is reserved for workspace services.")
        return value

    def validate_path(self, value):
        if not value.startswith("/") or value.startswith("//") or "\\" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise serializers.ValidationError("Use a path inside the preview, such as / or /dashboard.")
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc:
            raise serializers.ValidationError("External URLs are not preview paths.")
        return value


class PortPreviewThrottle(UserRateThrottle):
    scope = "port_preview"
    rate = "30/minute"


class SandboxPortPreviewView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [PortPreviewThrottle]

    def get(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        try:
            response = Response({"ports": listening_ports(project)})
        except APIException:
            raise
        except Exception:
            logger.exception("Could not list workspace preview ports")
            response = Response({"error": "Could not inspect workspace ports. Try again."}, status=502)
        response["Cache-Control"] = "no-store"
        return response

    def post(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        payload = PortPreviewRequest(data=request.data)
        payload.is_valid(raise_exception=True)
        try:
            response = Response(create_port_preview(project, request.user, **payload.validated_data))
        except APIException:
            raise
        except Exception:
            logger.exception("Could not open workspace port preview")
            response = Response({"error": "Could not open this workspace port. Check the server and try again."}, status=502)
        response["Cache-Control"] = "no-store"
        response["Referrer-Policy"] = "no-referrer"
        return response

    def delete(self, request, sandbox_uuid):
        project = _get_accessible_project(request.user, sandbox_uuid)
        payload = PortPreviewRequest(data=request.data)
        payload.is_valid(raise_exception=True)
        try:
            response = Response(close_port_preview(project, payload.validated_data["port"]))
        except APIException:
            raise
        except Exception:
            logger.exception("Could not close workspace port preview")
            response = Response({"error": "Could not revoke preview access. Try again."}, status=502)
        response["Cache-Control"] = "no-store"
        return response
