from django.urls import path

from . import oauth_views, views

urlpatterns = [
    path('', views.mcp_servers, name='mcp_servers'),
    path('oauth/client-metadata.json', oauth_views.metadata, name='mcp_oauth_metadata'),
    path('oauth/complete/', oauth_views.complete, name='mcp_oauth_complete'),
    path('<uuid:server_id>/oauth/start/', oauth_views.start, name='mcp_oauth_start'),
    path('<uuid:server_id>/oauth/status/', oauth_views.connection_status, name='mcp_oauth_status'),
    path('tools/', views.list_all_tools, name='list_all_tools'),
    path('execute/', views.execute_tool_call, name='execute_tool_call'),
    path('executions/', views.list_executions, name='list_executions'),
    path('executions/<uuid:execution_id>/', views.get_execution, name='get_execution'),
    path('<uuid:server_id>/', views.mcp_server_detail, name='mcp_server_detail'),
    path('<uuid:server_id>/test/', views.test_mcp_server, name='test_mcp_server'),
    path('<uuid:server_id>/refresh/', views.refresh_tools, name='refresh_tools'),
]
