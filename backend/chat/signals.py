"""
Signal to auto-update Message search_vector on save.
"""
import asyncio.constants
asyncio.constants.SSL_SHUTDOWN_TIMEOUT = 0.1

from concurrent.futures import ThreadPoolExecutor
from django.contrib.postgres.search import SearchVector
from django.db.models.signals import post_save, pre_save
from django.dispatch import receiver

from .models import Message, Request

_broadcast_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="broadcast_worker")


def _safe_broadcast_request(instance_uuid, data):
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer

    channel_layer = get_channel_layer()
    if channel_layer:
        group_name = f"request_{str(instance_uuid)}"
        try:
            async_to_sync(channel_layer.group_send)(
                group_name,
                {
                    "type": "request_update",
                    "request": data
                }
            )
        except Exception:
            pass


def clean_null_bytes(data):
    """Recursively remove null bytes (\x00 / \u0000) from string, list, and dict data."""
    if isinstance(data, str):
        return data.replace('\x00', '').replace('\u0000', '')
    elif isinstance(data, list):
        return [clean_null_bytes(item) for item in data]
    elif isinstance(data, dict):
        return {clean_null_bytes(k): clean_null_bytes(v) for k, v in data.items()}
    return data


@receiver(pre_save, sender=Message)
def clean_message_null_bytes(sender, instance, **kwargs):
    """Clean null bytes from Message fields before saving to PostgreSQL."""
    if instance.content:
        instance.content = clean_null_bytes(instance.content)
    if instance.thinking:
        instance.thinking = clean_null_bytes(instance.thinking)
    if instance.thinking_summary:
        instance.thinking_summary = clean_null_bytes(instance.thinking_summary)
    if instance.thinking_segments is not None:
        instance.thinking_segments = clean_null_bytes(instance.thinking_segments)
    if instance.phases is not None:
        instance.phases = clean_null_bytes(instance.phases)
    if instance.tool_calls is not None:
        instance.tool_calls = clean_null_bytes(instance.tool_calls)




@receiver(post_save, sender=Message)
def update_message_search_vector(sender, instance, created, **kwargs):
    """Update the tsvector search_vector field for full-text search on PostgreSQL."""
    from django.db import connection
    if connection.vendor == 'postgresql' and instance.content:
        try:
            Message.objects.filter(pk=instance.pk).update(
                search_vector=SearchVector('content', config='simple')
            )
        except Exception:
            pass


@receiver(post_save, sender=Request)
def broadcast_request_update(sender, instance, update_fields=None, **kwargs):
    """Broadcast Request update events asynchronously to their specific Channels group."""
    if update_fields:
        # Ignore high-frequency partial stream chunk updates (SSE delivers live stream to frontend)
        partial_only = all(f in {'partial_content', 'partial_thinking', 'partial_phases', 'partial_tool_calls', 'last_activity_at'} for f in update_fields)
        if partial_only:
            return

    from .views.serializers import serialize_request

    try:
        data = serialize_request(instance)
        _broadcast_executor.submit(_safe_broadcast_request, instance.uuid, data)
    except Exception:
        pass
