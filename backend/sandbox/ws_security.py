"""Short-lived, resource-bound, single-use WebSocket credentials."""
import hashlib
import secrets
import time

from django.contrib.auth import get_user_model
from django.core import signing
from django.conf import settings
from django.core.cache import cache, caches
from django.core.cache.backends.redis import RedisCache
from rest_framework.exceptions import APIException
from django.utils.crypto import constant_time_compare
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.tokens import AccessToken

SALT = "sandbox.websocket.v1"
TICKET_TTL = 30
SESSION_TTL = 900


def can_access_sandbox(user, project):
    if not user or not user.is_active:
        return False
    if user.is_staff or user.is_superuser:
        return True
    if project.workspace_id:
        return project.workspace.memberships.filter(user_id=user.pk).exists()
    return project.user_id == user.pk


class TicketStoreUnavailable(APIException):
    status_code = 503
    default_detail = "Shared Redis storage is required for terminal connection tickets."


def _check_ticket_store():
    if not settings.DEBUG and not isinstance(caches["default"], RedisCache):
        raise TicketStoreUnavailable()


def issue_ticket(user, resource, auth):
    _check_ticket_store()
    if not user.is_active or not isinstance(auth, AccessToken):
        raise AuthenticationFailed("An active user and an access token are required.")
    now = int(time.time())
    payload = {
        "user": str(user.pk), "resource": str(resource),
        "nonce": secrets.token_urlsafe(32),
        "session_exp": min(int(auth["exp"]), now + SESSION_TTL),
        "password": user.get_session_auth_hash(),
    }
    return signing.dumps(payload, salt=SALT)


def consume_ticket(ticket, resource):
    _check_ticket_store()
    payload = signing.loads(ticket, salt=SALT, max_age=TICKET_TTL)
    if payload["resource"] != str(resource) or payload["session_exp"] <= time.time():
        raise signing.BadSignature("Invalid connection ticket")
    # cache.add is atomic across Redis workers; cache outages fail closed.
    key = "ws-used:" + hashlib.sha256(payload["nonce"].encode()).hexdigest()
    if not cache.add(key, True, timeout=SESSION_TTL + TICKET_TTL):
        raise signing.BadSignature("Connection ticket already consumed")
    return payload


def ticket_user(payload):
    if payload["session_exp"] <= time.time():
        return None
    user = get_user_model().objects.filter(pk=payload["user"], is_active=True).first()
    if not user or not constant_time_compare(payload["password"], user.get_session_auth_hash()):
        return None
    return user
