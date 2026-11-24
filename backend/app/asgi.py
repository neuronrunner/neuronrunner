"""ASGI config for NeuronRunner."""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'app.settings')

django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import OriginValidator
from django.conf import settings

import sandbox.routing

websocket_allowed_origins = list(settings.CORS_ALLOWED_ORIGINS)
if settings.DEBUG or settings.CORS_ALLOW_ALL_ORIGINS:
    if "*" not in websocket_allowed_origins:
        websocket_allowed_origins.append("*")

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": OriginValidator(
        AuthMiddlewareStack(
            URLRouter(sandbox.routing.websocket_urlpatterns)
        ),
        websocket_allowed_origins,
    ),
})
