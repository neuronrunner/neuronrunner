from typing import Any, cast
from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r'^/?ws/sandbox/terminal/(?P<sandbox_uuid>[a-zA-Z0-9_-]+)/?$', cast(Any, consumers.TerminalConsumer.as_asgi())),
    re_path(r'^/?ws/chat/request/(?P<request_uuid>[a-zA-Z0-9_-]+)/?$', cast(Any, consumers.RequestStatusConsumer.as_asgi())),
]

