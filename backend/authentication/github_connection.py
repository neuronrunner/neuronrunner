"""Link GitHub repository access to the signed-in NeuronRunner account."""
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

PREFIX = "nr-connect:"
SALT = "github-repository-connection"
MAX_AGE = 600


def get_github_connection(user, uid=None):
    """Return the user's GitHub link for `uid`, or the most recently saved one."""
    qs = UserSocialAuth.objects.filter(user=user, provider="github").order_by("-id")
    if uid:
        return qs.filter(uid=str(uid)).first()
    return qs.first()


def revoke_github_token(token):
    """Best-effort revoke of a GitHub OAuth token; the local link is removed even if this fails."""
    client_id = settings.SOCIAL_AUTH_GITHUB_KEY
    client_secret = settings.SOCIAL_AUTH_GITHUB_SECRET
    if not token or not client_id or not client_secret:
        return
    try:
        response = requests.delete(
            f"https://api.github.com/applications/{client_id}/token",
            auth=(client_id, client_secret),
            headers={"Accept": "application/vnd.github+json"},
            json={"access_token": token},
            timeout=5,
        )
        if response.status_code not in (204, 404):
            logger.warning("GitHub token revocation returned HTTP %s", response.status_code)
    except requests.RequestException as exc:
        logger.warning("GitHub token revocation failed: %s", exc)


def replace_other_github_connections(user, uid):
    """Keep one GitHub account per NeuronRunner account and revoke replaced tokens."""
    others = list(UserSocialAuth.objects.filter(user=user, provider="github").exclude(uid=str(uid)))
    if not others:
        return
    UserSocialAuth.objects.filter(pk__in=[connection.pk for connection in others]).delete()
    for connection in others:
        revoke_github_token((connection.extra_data or {}).get("access_token"))


class GithubAccountsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        connection = UserSocialAuth.objects.filter(user=request.user, provider="github").order_by("-id").first()
        accounts = [] if not connection else [{"id": connection.uid, "login": (connection.extra_data or {}).get("login")}]
        return Response({"accounts": accounts})

    def delete(self, request, uid):
        connection = UserSocialAuth.objects.filter(user=request.user, provider="github", uid=str(uid)).first()
        if not connection:
            return Response({"deleted": False})
        revoke_github_token((connection.extra_data or {}).get("access_token"))
        connection.delete()
        return Response({"deleted": True})


def popup_response(origin, **payload):
    payload = {"source": "github-connection", **payload}
    # User-controlled GitHub names must not terminate the script element.
    serialized = json.dumps(payload).replace("<", "\\u003c")
    target = json.dumps(origin)
    connected = payload.get("connected", False)
    error = payload.get("error", "")

    if connected:
        content = '<p style="color:#10b981;font-weight:600;font-size:16px;">GitHub connection complete.</p><p style="color:#94a3b8;font-size:13px;margin-top:6px;">You can close this window.</p>'
        close_script = 'setTimeout(function(){window.close();},400);'
    else:
        escaped_err = str(error).replace("<", "&lt;").replace(">", "&gt;")
        content = f'<p style="color:#ef4444;font-weight:600;font-size:16px;">GitHub connection failed</p><p style="color:#94a3b8;font-size:13px;margin-top:6px;">{escaped_err}</p><button onclick="window.close()" style="margin-top:16px;padding:8px 16px;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Close Window</button>'
        close_script = 'setTimeout(function(){window.close();},3000);'

    response = HttpResponse(f'''<!doctype html><html><head><title>GitHub connection</title>
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


class GithubConnectionStartView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        if not settings.SOCIAL_AUTH_GITHUB_KEY or not settings.SOCIAL_AUTH_GITHUB_SECRET:
            return Response({"error": "GitHub connection is not configured on this server."}, status=503)
        origin = request.headers.get("Origin") or settings.FRONTEND_BASE_URL
        origin = f"{urlsplit(origin).scheme}://{urlsplit(origin).netloc}"
        allowed = set(getattr(settings, "CORS_ALLOWED_ORIGINS", [])) | {settings.FRONTEND_BASE_URL}
        if origin not in allowed:
            return Response({"error": "This app origin cannot connect GitHub."}, status=400)
        nonce = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        state = PREFIX + signing.dumps({"nonce": nonce, "user": str(request.user.pk), "origin": origin}, salt=SALT)
        set_cache(f"github-connect:{nonce}", {"verifier": verifier}, timeout=MAX_AGE)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        redirect_uri = getattr(settings, "GITHUB_REDIRECT_URI", None) or os.getenv("GITHUB_REDIRECT_URI", "").strip() or request.build_absolute_uri(reverse("github_oauth_callback"))
        params = {"client_id": settings.SOCIAL_AUTH_GITHUB_KEY, "redirect_uri": redirect_uri, "scope": "repo read:user", "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "prompt": "select_account"}
        return Response({"authorization_url": "https://github.com/login/oauth/authorize?" + urlencode(params)})


def complete_github_connection(request):
    """Handle only signed connection state; never change the local login account."""
    try:
        claims = signing.loads(request.GET.get("state", "")[len(PREFIX):], salt=SALT, max_age=MAX_AGE)
        pending = get_cache(f"github-connect:{claims['nonce']}")
        if not pending:
            raise signing.BadSignature("Expired or already used state")
        delete_cache(f"github-connect:{claims['nonce']}")
    except (signing.BadSignature, KeyError, TypeError, ValueError):
        return Response({"error": "GitHub connection expired. Close this window and connect again."}, status=400)
    origin = claims["origin"]
    user_pk = claims["user"]
    def fail(message):
        logger.warning("GitHub connection failed for user %s: %s", user_pk, message)
        set_cache(f"github-connect-error:{user_pk}", message, timeout=120)
        return popup_response(origin, connected=False, error=message)

    if request.GET.get("error") or not request.GET.get("code"):
        return fail("GitHub authorization was cancelled. Connect again to enable private repositories.")
    user = get_user_model().objects.filter(pk=claims["user"], is_active=True).first()
    if not user:
        return fail("Your session is no longer available. Sign in and connect again.")
    try:
        redirect_uri = getattr(settings, "GITHUB_REDIRECT_URI", None) or os.getenv("GITHUB_REDIRECT_URI", "").strip() or request.build_absolute_uri(reverse("github_oauth_callback"))
        token_data = {"client_id": settings.SOCIAL_AUTH_GITHUB_KEY, "client_secret": settings.SOCIAL_AUTH_GITHUB_SECRET, "code": request.GET["code"], "redirect_uri": redirect_uri, "code_verifier": pending["verifier"]}
        response = requests.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"}, data=token_data, timeout=15)
        response.raise_for_status()
        data = response.json()
        token = data.get("access_token")
        if not token:
            return fail("GitHub authorization could not be completed. Connect again.")
        profile = requests.get("https://api.github.com/user", headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}, timeout=15)
        profile.raise_for_status()
        github_user = profile.json()
        scopes = data.get("scope", profile.headers.get("X-OAuth-Scopes", ""))
        scopes = scopes.replace(",", " ").split()
        if "repo" not in scopes:
            return fail("GitHub did not grant private repository access. Reconnect and allow repository access.")
        uid, login = str(github_user.get("id") or ""), github_user.get("login")
        if not uid or not login:
            return fail("Your GitHub account could not be identified. Connect again.")
        if UserSocialAuth.objects.filter(provider="github", uid=uid).exclude(user=user).exists():
            return fail("This GitHub account is linked to another Neuron Runner account.")
        replace_other_github_connections(user, uid)
        with transaction.atomic():
            connection, _ = UserSocialAuth.objects.get_or_create(user=user, provider="github", uid=uid)
            connection.extra_data = {"access_token": token, "login": login, "id": uid, "scope": ",".join(scopes)}
            connection.save()
        delete_cache(f"github-connect-error:{user.pk}")
        return popup_response(origin, connected=True, username=login)
    except (requests.RequestException, ValueError, TypeError, AttributeError, IntegrityError) as exc:
        logger.exception("GitHub connection exception for user %s: %s", user_pk, exc)
        return fail("GitHub connection could not be completed. Try again.")
