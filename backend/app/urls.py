from django.conf import settings
from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path

from core.extensions import expand_urlpatterns, registry as ext_registry
from sandbox.views import SandboxSuggestionsView

urlpatterns = [
    path('auth/', include('authentication.urls')),
    path('models/', include('model.urls')),
    path('users/', include('user.urls')),
    path('mcp/', include('mcp.urls')),
    path('sandbox/', include('sandbox.urls')),
    path('issues/', include('issues.urls')),
    *expand_urlpatterns(ext_registry.app.extra_urlpatterns),
    path(
        'sandboxes/<uuid:sandbox_uuid>/suggestions/',
        SandboxSuggestionsView.as_view(),
        name='sandbox-suggestions-root',
    ),
    path('', include('openai_compat.urls')),
    path('', include('chat.urls')),
    path('', lambda request: JsonResponse({"status": "ok", "service": "Neuron Runner API"})),
    path('health/', lambda request: JsonResponse({"status": "ok"})),
    path(
        'config/',
        lambda request: JsonResponse({
            "sandbox_provider": settings.SANDBOX_PROVIDER,
            "turnstile_required": bool(settings.TURNSTILE_SECRET and settings.TURNSTILE_REQUIRED),
            **ext_registry.app.extra_config_payload(settings),
        }),
    ),
]

if settings.ENABLE_ADMIN:
    urlpatterns.append(path('admin/', admin.site.urls))

handler404 = lambda request, exception: JsonResponse({"error": "Not found"}, status=404)
handler500 = lambda request: JsonResponse({"error": "Internal server error"}, status=500)
