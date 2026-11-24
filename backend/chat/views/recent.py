"""
Recent models view.
"""

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from chat.models import Request
from model.reasoning import get_model_reasoning_spec

from .helpers import coerce_int


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def recent_models(request):
    """Get recent models used by the authenticated user."""
    limit = max(1, min(coerce_int(request.query_params.get('limit'), 6), 20))

    # Get recent requests by this user with distinct models
    recent_requests = (
        Request.objects
        .filter(user=request.user, model__isnull=False)
        .select_related('model', 'model__llm_config')
        .order_by('-created_at')
    )

    seen_models = set()
    results = []

    from sandbox.services.provider_keys import (
        configured_providers,
        model_is_usable,
        request_workspace,
    )
    workspace = request_workspace(request)
    providers = configured_providers(workspace)

    for req in recent_requests[:200]:
        if req.model and req.model.name not in seen_models:
            seen_models.add(req.model.name)
            if not model_is_usable(req.model, workspace, providers):
                continue
            spec = get_model_reasoning_spec(req.model)
            results.append({
                "name": req.model.name,
                "type": req.model.model_type,
                "is_reasoning": spec["is_reasoning"],
                "reasoning_mode": spec["mode"],
                "reasoning_tiers": spec["tiers"],
                "default_reasoning_effort": spec["default"],
            })
            if len(results) >= limit:
                break

    return Response(results)
