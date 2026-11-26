from django.urls import path

from . import views

urlpatterns = [
    path('predict/<str:model_id>/', views.predict, name='predict'),

    path('attachments/<uuid:attachment_id>/download/', views.download_attachment, name='download_attachment'),
    path('conversations/<uuid:conversation_id>/', views.get_chat, name='get_chat'),
    path('conversations/<uuid:conversation_id>/rename/', views.rename_conversation, name='rename_conversation'),
    path('conversations/<uuid:conversation_id>/delete/', views.delete_conversation, name='delete_conversation'),
    path('conversations/<uuid:conversation_id>/messages/<uuid:message_uuid>/undo/', views.undo_message, name='undo_message'),
    path('messages/<uuid:message_uuid>/undo/', views.undo_message, name='undo_message_direct'),
    path('conversations/', views.get_conversations, name='get_messages'),
    path('recent-models/', views.recent_models, name='recent_models'),
    # Hermes-style memory tool endpoints
    path('tools/memory/add/', views.memory_add, name='tool_memory_add'),
    path('tools/memory/replace/', views.memory_replace, name='tool_memory_replace'),
    path('tools/memory/remove/', views.memory_remove, name='tool_memory_remove'),
    path('tools/memory/list/', views.memory_list, name='tool_memory_list'),
    path('tools/note/add/', views.note_add, name='tool_note_add'),
    path('tools/note/replace/', views.note_replace, name='tool_note_replace'),
    path('tools/note/remove/', views.note_remove, name='tool_note_remove'),
    path('tools/note/list/', views.note_list, name='tool_note_list'),
    path('tools/execute/', views.execute_tool, name='tool_execute'),
    path('tools/execute/stream/', views.execute_tool_stream, name='tool_execute_stream'),
    path('tools/byos-mcp/', views.byos_mcp_bridge, name='tool_byos_mcp_bridge'),
    # Legacy memory endpoints (keep for backward compat)
    path('memories/', views.list_memories, name='list_memories'),
    path('memories/all/', views.delete_all_memories, name='delete_all_memories'),
    path('memories/<uuid:memory_id>/', views.delete_memory, name='delete_memory'),
    path('memories/<uuid:memory_id>/update/', views.update_memory, name='update_memory'),
    path('requests/', views.list_requests, name='list_requests'),
    path('requests/stats/', views.get_request_stats, name='get_request_stats'),
    path('requests/<uuid:request_id>/', views.get_request, name='get_request'),
    path('requests/<uuid:request_id>/cancel/', views.cancel_request, name='cancel_request'),
    path('conversations/<uuid:conversation_id>/cancel/', views.cancel_conversation_active_request, name='cancel_conversation_active_request'),
]
