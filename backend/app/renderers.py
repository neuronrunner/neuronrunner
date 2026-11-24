from rest_framework.renderers import BaseRenderer


class ServerSentEventRenderer(BaseRenderer):
    """
    Renderer for Server-Sent Events (SSE) streaming responses.
    Allows Django REST Framework views to accept 'Accept: text/event-stream'
    without raising HTTP 406 Not Acceptable.
    """
    media_type = 'text/event-stream'
    format = 'txt'
    charset = 'utf-8'

    def render(self, data, accepted_media_type=None, renderer_context=None):
        if isinstance(data, (bytes, bytearray)):
            return data
        if isinstance(data, str):
            return data.encode(self.charset)
        return data
