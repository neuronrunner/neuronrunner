"""
Serialization helpers for chat views.
"""

from datetime import timedelta

from django.utils import timezone
from utils.image_placeholders import build_blur_data_url

PROCESSING_TIMEOUT = timedelta(minutes=10)
PENDING_TIMEOUT = timedelta(minutes=5)


def maybe_mark_request_timed_out(request_obj) -> bool:
    """Mark a stuck request as failed when it is read (lazy timeout).

    Returns True if the request was just timed out. No-op for requests that
    are not stuck, already finalized, or were canceled by the user.
    """
    if request_obj.status not in ('pending', 'processing'):
        return False

    from chat.constants import GENERATION_CANCELED_ERROR
    if request_obj.error_message == GENERATION_CANCELED_ERROR:
        return False

    now = timezone.now()
    stuck_status = request_obj.status
    if stuck_status == 'pending':
        threshold = PENDING_TIMEOUT
        reference = request_obj.created_at
    else:
        threshold = PROCESSING_TIMEOUT
        reference = request_obj.last_activity_at or request_obj.started_at or request_obj.created_at

    if reference is None or now - reference < threshold:
        return False

    # A worker heartbeat or completion can race this read. Fail only the same
    # stale state; never overwrite a live worker or a finished request.
    from chat.models import Request
    values = {
        'status': 'failed',
        'error_message': (
            f"Request timed out after {threshold.total_seconds() / 60:.0f} minutes "
            + ("without a worker heartbeat" if stuck_status == 'processing' else "pending without starting")
        ),
        'completed_at': now,
        'duration_seconds': (now - (request_obj.started_at or request_obj.created_at)).total_seconds(),
    }
    updated = Request.objects.filter(
        pk=request_obj.pk, status=stuck_status,
        last_activity_at=request_obj.last_activity_at,
        started_at=request_obj.started_at,
    ).update(**values)
    if not updated:
        request_obj.refresh_from_db()
        return False
    for field, value in values.items():
        setattr(request_obj, field, value)
    return True


def serialize_image(image, request_user=None) -> dict:
    """Serialize an Image model instance to a dictionary."""
    model = getattr(image, "model", None)
    user = (
        getattr(image.message.conversation, "user", None)
        if image.message and image.message.conversation
        else None
    )

    # Calculate reactions
    reactions_list = list(image.reactions.all())
    reaction_counts = {}
    user_reactions = []

    for r in reactions_list:
        reaction_counts[r.emoji] = reaction_counts.get(r.emoji, 0) + 1
        if request_user and request_user.is_authenticated and r.user_id == request_user.uuid:
            user_reactions.append(r.emoji)

    # Sort reactions by count then alphabetically
    sorted_reactions = dict(sorted(reaction_counts.items(), key=lambda x: (x[1], x[0])))
    user_reactions.sort()

    category_names = [category.name for category in image.related_categories.all()]

    return {
        "uuid": str(image.uuid),
        "image_url": image.image.url,
        "image_blur_data_url": build_blur_data_url(image.image, cache_prefix='placeholder:generated-image'),
        "prompt": image.prompt,
        "negative_prompt": image.negative_prompt,
        "width": image.width,
        "height": image.height,
        "seed": image.seed,
        "num_inference_steps": image.num_inference_steps,
        "model": model.name if model else None,
        "tag": None,
        "model_author": model.author.username if model and model.author else None,
        "user": user.username if user else None,
        "shared": image.shared,
        "shared_at": image.shared_at,
        "related_categories": category_names,
        "created_at": image.created_at,
        "reactions": sorted_reactions,
        "user_reactions": user_reactions,
    }


def serialize_comment(comment) -> dict:
    """Serialize a comment object."""
    return {
        "uuid": str(comment.uuid),
        "user": comment.user.username,
        "user_profile_picture": comment.user.profile_picture.url if comment.user.profile_picture else None,
        "user_profile_picture_blur_data_url": build_blur_data_url(comment.user.profile_picture, cache_prefix='placeholder:profile-picture'),
        "content": comment.content,
        "created_at": comment.created_at.isoformat(),
        "updated_at": comment.updated_at.isoformat(),
    }


def serialize_request(request_obj) -> dict:
    """Serialize a Request model instance to a dictionary."""
    maybe_mark_request_timed_out(request_obj)
    credits_used = float(request_obj.cost) if request_obj.cost is not None else None
    conversation = getattr(request_obj, "conversation", None)
    parent = getattr(request_obj, "parent", None)
    model = getattr(request_obj, "model", None)

    images = []
    if parent is not None:
        for child in parent.children.all():
            if child.type == 'image':
                for img in child.images.all():
                    images.append({
                        "uuid": str(img.uuid),
                        "image_url": img.image.url,
                        "prompt": img.prompt,
                    })

    from utils.cache import get_request_stream_state
    from mcp.catalog import format_tool_name

    stream_state = get_request_stream_state(str(request_obj.uuid)) or {}
    partial_content = stream_state.get("content") if stream_state.get("content") is not None else request_obj.partial_content
    partial_thinking = stream_state.get("thinking") if stream_state.get("thinking") is not None else request_obj.partial_thinking
    partial_phases = stream_state.get("phases") if stream_state.get("phases") is not None else (request_obj.partial_phases or [])
    partial_tool_calls = stream_state.get("tool_calls") if stream_state.get("tool_calls") is not None else (request_obj.partial_tool_calls or [])

    if partial_tool_calls:
        for tc in partial_tool_calls:
            if isinstance(tc, dict):
                name = tc.get("name") or tc.get("function_name") or (tc.get("function", {}).get("name") if isinstance(tc.get("function"), dict) else "")
                if name and not tc.get("title"):
                    tc["title"] = format_tool_name(name)

    if partial_phases:
        for p in partial_phases:
            if isinstance(p, dict):
                name = p.get("toolName")
                if name and not p.get("title"):
                    p["title"] = format_tool_name(name)

    return {
        "uuid": str(request_obj.uuid),
        "created_at": request_obj.created_at.isoformat(),
        "started_at": request_obj.started_at.isoformat() if request_obj.started_at else None,
        "completed_at": request_obj.completed_at.isoformat() if request_obj.completed_at else None,
        "status": request_obj.status,
        "error_message": request_obj.error_message,
        "partial_content": partial_content,
        "partial_thinking": partial_thinking,
        "phases": partial_phases,
        "tool_calls": partial_tool_calls,
        "conversation_uuid": str(conversation.uuid) if conversation else None,
        "parent_uuid": str(parent.uuid) if parent else None,
        "model": model.name if model else None,
        "model_type": model.model_type if model else None,
        "model_tag": model.name if model else None,
        "cost_usd": credits_used,
        "cost": credits_used,
        "workspace_uuid": str(request_obj.workspace_id) if request_obj.workspace_id else None,
        "uses_byok": request_obj.uses_byok,
        "charged_cost": str(request_obj.charged_cost),
        "cached_input_tokens": request_obj.cached_input_tokens,
        "input_tokens": request_obj.input_tokens,
        "output_tokens": request_obj.output_tokens,
        "duration_seconds": request_obj.duration_seconds,
        "pricing_model": request_obj.pricing_model_snapshot,
        "images": images,
    }
