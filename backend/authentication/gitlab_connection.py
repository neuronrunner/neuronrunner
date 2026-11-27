"""Link GitLab repository access to the signed-in Neuron Runner account."""
import base64
import hashlib
import json
import logging
import os
import secrets
from urllib.parse import urlencode, urlsplit

import requests
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import signing
from django.db import IntegrityError, transaction
from django.http import HttpResponse
from django.urls import reverse
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView
from social_django.models import UserSocialAuth

from utils.cache import delete_cache, get_cache, set_cache

logger = logging.getLogger(__name__)

PREFIX = "nr-gitlab-connect:"
SALT = "gitlab-repository-connection"
MAX_AGE = 600


def _gitlab_config():
    base_url = (getattr(settings, "GITLAB_BASE_URL", None) or os.getenv("GITLAB_BASE_URL", "https://gitlab.com")).strip().rstrip("/")
    client_id = (getattr(settings, "GITLAB_CLIENT_ID", None) or os.getenv("GITLAB_CLIENT_ID", "")).strip()
    client_secret = (getattr(settings, "GITLAB_CLIENT_SECRET", None) or os.getenv("GITLAB_CLIENT_SECRET", "")).strip()
    return base_url, client_id, client_secret


def _gitlab_redirect_uri(request):
    return (
        getattr(settings, "GITLAB_REDIRECT_URI", None)
        or os.getenv("GITLAB_REDIRECT_URI", "").strip()
        or request.build_absolute_uri(reverse("gitlab_oauth_callback"))
    )


def revoke_gitlab_token(token):
    """Best-effort revoke of a GitLab OAuth token; the local link is removed even if this fails."""
    base_url, client_id, client_secret = _gitlab_config()
    if not token or not client_id or not client_secret:
        return
    try:
        response = requests.post(
            f"{base_url}/oauth/revoke",
            data={"client_id": client_id, "client_secret": client_secret, "token": token},
            timeout=5,
        )
        if response.status_code not in (200, 204):
            logger.warning("GitLab token revocation returned HTTP %s", response.status_code)
    except requests.RequestException as exc:
        logger.warning("GitLab token revocation failed: %s", exc)


def replace_other_gitlab_connections(user, uid):
    """Keep one GitLab account per Neuron Runner account and revoke replaced tokens."""
    others = list(UserSocialAuth.objects.filter(user=user, provider="gitlab").exclude(uid=str(uid)))
    if not others:
        return
    UserSocialAuth.objects.filter(pk__in=[connection.pk for connection in others]).delete()
    for connection in others:
        revoke_gitlab_token((connection.extra_data or {}).get("access_token"))


class GitlabAccountsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        _, client_id, client_secret = _gitlab_config()
        connection = UserSocialAuth.objects.filter(user=request.user, provider="gitlab").order_by("-id").first()
        accounts = [] if not connection else [{"id": connection.uid, "login": (connection.extra_data or {}).get("login")}]
        return Response({"accounts": accounts, "configured": bool(client_id and client_secret)})

    def delete(self, request, uid):
        connection = UserSocialAuth.objects.filter(user=request.user, provider="gitlab", uid=str(uid)).first()
        if not connection:
            return Response({"deleted": False})
        revoke_gitlab_token((connection.extra_data or {}).get("access_token"))
        connection.delete()
        return Response({"deleted": True})


def popup_response(origin, **payload):
    payload = {"source": "gitlab-connection", **payload}
    serialized = json.dumps(payload).replace("<", "\\u003c")
    target = json.dumps(origin)
    connected = payload.get("connected", False)
    error = payload.get("error", "")

    if connected:
        content = '<p style="color:#10b981;font-weight:600;font-size:16px;">GitLab connection complete.</p><p style="color:#94a3b8;font-size:13px;margin-top:6px;">You can close this window.</p>'
        close_script = "setTimeout(function(){window.close();},400);"
    else:
        escaped_err = str(error).replace("<", "&lt;").replace(">", "&gt;")
        content = f'<p style="color:#ef4444;font-weight:600;font-size:16px;">GitLab connection failed</p><p style="color:#94a3b8;font-size:13px;margin-top:6px;">{escaped_err}</p><button onclick="window.close()" style="margin-top:16px;padding:8px 16px;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Close Window</button>'
        close_script = "setTimeout(function(){window.close();},3000);"

    response = HttpResponse(f'''<!doctype html><html><head><title>GitLab connection</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0b0f17; color: #f8fafc; text-align: center; padding: 20px; box-sizing: border-box; }}
</style>
</head>
<body>{content}<script>
try {{
    if(window.opener) window.opener.postMessage({serialized}, {target});
}} catch(e) {{}}
{close_script}
</script></body></html>''')
    response["Cross-Origin-Opener-Policy"] = "unsafe-none"
    return response


class GitlabConnectionStartView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        base_url, client_id, client_secret = _gitlab_config()
        if not client_id or not client_secret:
            return Response({"error": "GitLab connection is not configured on this server."}, status=503)
        origin = request.headers.get("Origin") or settings.FRONTEND_BASE_URL
        origin = f"{urlsplit(origin).scheme}://{urlsplit(origin).netloc}"
        allowed = set(getattr(settings, "CORS_ALLOWED_ORIGINS", [])) | {settings.FRONTEND_BASE_URL}
        if origin not in allowed:
            return Response({"error": "This app origin cannot connect GitLab."}, status=400)
        nonce = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        state = PREFIX + signing.dumps({"nonce": nonce, "user": str(request.user.pk), "origin": origin}, salt=SALT)
        set_cache(f"gitlab-connect:{nonce}", {"verifier": verifier}, timeout=MAX_AGE)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        redirect_uri = _gitlab_redirect_uri(request)
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "read_user read_repository write_repository",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        return Response({"authorization_url": f"{base_url}/oauth/authorize?" + urlencode(params)})


class GitlabOAuthCallbackView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        raw_state = request.GET.get("state", "")
        if not raw_state.startswith(PREFIX):
            return Response({"error": "Invalid GitLab connection state."}, status=400)
        try:
            claims = signing.loads(raw_state[len(PREFIX):], salt=SALT, max_age=MAX_AGE)
            pending = get_cache(f"gitlab-connect:{claims['nonce']}")
            if not pending:
                raise signing.BadSignature("Expired or already used state")
            delete_cache(f"gitlab-connect:{claims['nonce']}")
        except (signing.BadSignature, KeyError, TypeError, ValueError):
            return Response({"error": "GitLab connection expired. Close this window and connect again."}, status=400)

        origin = claims["origin"]
        user_pk = claims["user"]

        def fail(message):
            logger.warning("GitLab connection failed for user %s: %s", user_pk, message)
            return popup_response(origin, connected=False, error=message)

        if request.GET.get("error") or not request.GET.get("code"):
            return fail("GitLab authorization was cancelled. Connect again to link your account.")

        user = get_user_model().objects.filter(pk=user_pk, is_active=True).first()
        if not user:
            return fail("Your session is no longer available. Sign in and connect again.")

        base_url, client_id, client_secret = _gitlab_config()
        try:
            redirect_uri = _gitlab_redirect_uri(request)
            token_data = {
                "client_id": client_id,
                "client_secret": client_secret,
                "code": request.GET["code"],
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
                "code_verifier": pending["verifier"],
            }
            response = requests.post(
                f"{base_url}/oauth/token",
                headers={"Accept": "application/json"},
                data=token_data,
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
            token = data.get("access_token")
            if not token:
                return fail("GitLab authorization could not be completed. Connect again.")

            profile = requests.get(
                f"{base_url}/api/v4/user",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                timeout=15,
            )
            profile.raise_for_status()
            gitlab_user = profile.json()
            uid = str(gitlab_user.get("id") or "")
            login = gitlab_user.get("username")
            if not uid or not login:
                return fail("Your GitLab account could not be identified. Connect again.")

            if UserSocialAuth.objects.filter(provider="gitlab", uid=uid).exclude(user=user).exists():
                return fail("This GitLab account is linked to another Neuron Runner account.")

            replace_other_gitlab_connections(user, uid)
            with transaction.atomic():
                connection, _ = UserSocialAuth.objects.get_or_create(user=user, provider="gitlab", uid=uid)
                connection.extra_data = {
                    "access_token": token,
                    "refresh_token": data.get("refresh_token"),
                    "login": login,
                    "id": uid,
                    "scope": data.get("scope", ""),
                    "created_at": gitlab_user.get("created_at"),
                }
                connection.save()
            return popup_response(origin, connected=True, username=login)
        except (requests.RequestException, ValueError, TypeError, AttributeError, IntegrityError) as exc:
            logger.exception("GitLab connection exception for user %s: %s", user_pk, exc)
            return fail("GitLab connection could not be completed. Try again.")
