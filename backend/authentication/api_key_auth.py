from django.utils import timezone
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed
from user.models import ApiKey


class ApiKeyAuthentication(BaseAuthentication):
    """
    Custom authentication backend that allows users to authenticate
    using API keys via the Authorization header.

    Supports:
      - Authorization: Bearer nrk_...
    
    Only processes keys that start with "nrk_" to avoid interfering with other authentication schemes (like JWT).
    """

    def authenticate(self, request):
        auth_header = request.META.get("HTTP_AUTHORIZATION", "")
        if not auth_header:
            return None

        parts = auth_header.split()
        if len(parts) != 2:
            return None

        scheme, raw_key = parts

        # Only handle "Bearer" scheme
        if scheme != "Bearer":
            return None

        # Only intercept keys that look like ours (nrk_ prefix)
        # Let other tokens fall through to TokenAuthentication
        if not raw_key.startswith("nrk_"):
            return None
        key_hash = ApiKey.hash_key(raw_key)

        try:
            api_key = ApiKey.objects.select_related("user").get(
                key_hash=key_hash, is_active=True
            )
        except ApiKey.DoesNotExist:
            raise AuthenticationFailed("Invalid or inactive API key.")

        if not api_key.user.is_active:
            raise AuthenticationFailed("User account is disabled.")

        # Update last_used_at (fire-and-forget, don't block the request)
        ApiKey.objects.filter(pk=api_key.pk).update(last_used_at=timezone.now())

        return (api_key.user, api_key)

    def authenticate_header(self, request):
        return "Bearer"
