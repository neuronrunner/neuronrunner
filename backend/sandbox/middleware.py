"""Route a request's sandbox calls to the runtime the client selected."""
from __future__ import annotations

from sandbox.services.sandbox_session import use_runtime

RUNTIME_HEADER = "HTTP_X_SANDBOX_RUNTIME"


class SandboxRuntimeMiddleware:
    """Apply the ``X-Sandbox-Runtime`` header for the duration of the view.

    Only named local Docker runtimes are honoured; anything else (no header,
    ``default``, or a remote provider) keeps the workspace's default runtime.
    Streaming responses that touch the sandbox after the view returns must read
    the header themselves.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        value = request.META.get(RUNTIME_HEADER)
        if not value:
            return self.get_response(request)
        with use_runtime(value):
            return self.get_response(request)
