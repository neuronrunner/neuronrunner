"""Internal signed endpoint for the BYOS guest MCP server (POST /tools/byos-mcp/)."""
from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from chat.models import Conversation
from chat.services.byos_mcp_bridge import (
    execute_byos_mcp_tool,
    list_byos_mcp_tools,
    verify_byos_mcp_token,
)

User = get_user_model()


def _extract_bearer(request) -> str:
    header = request.META.get("HTTP_AUTHORIZATION") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


@csrf_exempt
@require_POST
def byos_mcp_bridge(request):
    claims = verify_byos_mcp_token(_extract_bearer(request))
    if not claims:
        return JsonResponse({"error": "Invalid or expired BYOS MCP bridge token."}, status=401)

    user = User.objects.filter(pk=claims["u"]).first()
    conversation = Conversation.objects.filter(uuid=claims["c"]).select_related("workspace", "user").first()
    if not user or not conversation:
        return JsonResponse({"error": "Conversation or user not found."}, status=404)

    try:
        body = json.loads(request.body.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"error": "Invalid JSON body."}, status=400)

    action = str(body.get("action") or "").strip().lower()
    if action == "list":
        return JsonResponse({"tools": list_byos_mcp_tools(user, conversation)})

    if action == "call":
        name = str(body.get("name") or "").strip()
        if not name:
            return JsonResponse({"error": "Tool name is required."}, status=400)
        arguments = body.get("arguments") if isinstance(body.get("arguments"), dict) else {}
        result = execute_byos_mcp_tool(user, conversation, name, arguments)
        return JsonResponse({"result": result})

    return JsonResponse({"error": f"Unsupported action: {action}"}, status=400)
