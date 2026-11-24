import logging
import os
import re
import secrets
from datetime import timedelta

from sandbox.services.sandbox_service import SandboxBootstrapService
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core import signing
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from social_core.exceptions import AuthForbidden, AuthTokenError, MissingBackend
from social_django.utils import load_backend, load_strategy
from user.serializers import UserSerializer
from utils.cache import delete_cache, get_cache, set_cache

from .models import OTP
from .serializers import LoginSerializer, SocialAuthSerializer
from .services.email_hygiene import validate_registration_email
from .services.turnstile import get_client_ip, verify_turnstile_token

User = get_user_model()

logger = logging.getLogger(__name__)
PASSWORD_RESET_TOKEN_SALT = 'password_reset'
PASSWORD_RESET_TOKEN_MAX_AGE_SECONDS = 15 * 60
RESET_TOKEN_CACHE_PREFIX = 'used_reset_token:'
OTP_ATTEMPT_CACHE_PREFIX = 'otp_attempts:'
MAX_OTP_ATTEMPTS = 5
OTP_ATTEMPT_TIMEOUT = 300  # 5 minutes


def _record_user_auth_metadata(user, *, method=None, request=None, is_new=False):
    """Update last_login and capture signup attribution on first creation."""
    update_fields = ['last_login']
    user.last_login = timezone.now()
    if is_new:
        if method and not user.signup_method:
            user.signup_method = str(method)[:24]
            update_fields.append('signup_method')
        elif method:
            user.signup_method = str(method)[:24]
            update_fields.append('signup_method')
        data = getattr(request, 'data', {}) if request is not None else {}
        if isinstance(data, dict):
            src = (data.get('utm_source') or data.get('signup_source') or data.get('referrer') or '').strip()
            med = (data.get('utm_medium') or '').strip()
            camp = (data.get('utm_campaign') or '').strip()
            if src:
                user.signup_source = src[:120]
                update_fields.append('signup_source')
            if med:
                user.utm_medium = med[:120]
                update_fields.append('utm_medium')
            if camp:
                user.utm_campaign = camp[:120]
                update_fields.append('utm_campaign')
    user.save(update_fields=update_fields)


def build_auth_payload(user):
    refresh = RefreshToken.for_user(user)
    access = str(refresh.access_token)
    return {
        'token': access,
        'access': access,
        'refresh': str(refresh),
        'user': UserSerializer(user).data,
    }


def build_password_reset_token(email):
    return signing.dumps({'email': email, 'purpose': 'password_reset'}, salt=PASSWORD_RESET_TOKEN_SALT)


def parse_password_reset_token(reset_token):
    try:
        payload = signing.loads(
            reset_token,
            salt=PASSWORD_RESET_TOKEN_SALT,
            max_age=PASSWORD_RESET_TOKEN_MAX_AGE_SECONDS,
        )
    except signing.BadSignature:
        return None

    if payload.get('purpose') != 'password_reset':
        return None

    return payload


def is_token_used(reset_token):
    """Check if reset token has already been used"""
    cache_key = f"{RESET_TOKEN_CACHE_PREFIX}{reset_token}"
    return get_cache(cache_key) is not None


def mark_token_used(reset_token):
    """Mark reset token as used to prevent replay attacks"""
    cache_key = f"{RESET_TOKEN_CACHE_PREFIX}{reset_token}"
    set_cache(cache_key, True, timeout=PASSWORD_RESET_TOKEN_MAX_AGE_SECONDS)


def check_rate_limit(key_prefix, identifier, max_attempts, timeout):
    """Generic rate limiting check"""
    cache_key = f"{key_prefix}{identifier}"
    attempts = get_cache(cache_key)
    attempts = int(attempts) if attempts is not None else 0

    if attempts >= max_attempts:
        return False, "Too many attempts. Please try again later."

    set_cache(cache_key, attempts + 1, timeout=timeout)
    return True, None


SIGNUP_IP_CACHE_PREFIX = 'signup_ip:'


def _check_signup_ip_limit(request) -> tuple[bool, str | None]:
    max_signups = int(getattr(settings, 'MAX_SIGNUPS_PER_IP_PER_DAY', 3) or 0)
    if max_signups <= 0:
        return True, None
    ip = get_client_ip(request)
    if not ip:
        return True, None
    count = get_cache(f"{SIGNUP_IP_CACHE_PREFIX}{ip}")
    count = int(count) if count is not None else 0
    if count >= max_signups:
        return False, "Too many accounts created from this IP address. Please try again later."
    return True, None


def _record_signup_ip(request) -> None:
    max_signups = int(getattr(settings, 'MAX_SIGNUPS_PER_IP_PER_DAY', 3) or 0)
    if max_signups <= 0:
        return
    ip = get_client_ip(request)
    if not ip:
        return
    window = int(getattr(settings, 'SIGNUP_IP_WINDOW_SECONDS', 86400) or 86400)
    cache_key = f"{SIGNUP_IP_CACHE_PREFIX}{ip}"
    count = get_cache(cache_key)
    count = int(count) if count is not None else 0
    set_cache(cache_key, count + 1, timeout=window)


class SendOTPView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'send_otp'

    def post(self, request):
        turnstile_token = request.data.get('cf_turnstile_response') or request.data.get('turnstile_token')
        ok, err_msg = verify_turnstile_token(request, turnstile_token, expected_action='send_otp')
        if not ok:
            return Response({"error": err_msg}, status=status.HTTP_403_FORBIDDEN)

        ip_ok, ip_err = _check_signup_ip_limit(request)
        if not ip_ok:
            return Response({"error": ip_err}, status=status.HTTP_429_TOO_MANY_REQUESTS)

        email = request.data.get('email')
        if not email:
            return Response({"error": "Email required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            validate_email(email)
        except ValidationError:
            return Response({"error": "Invalid email"}, status=status.HTTP_400_BAD_REQUEST)

        hygiene_error = validate_registration_email(email)
        if hygiene_error:
            return Response({"error": hygiene_error}, status=status.HTTP_400_BAD_REQUEST)

        # Delete existing OTPs and create new one
        OTP.objects.filter(email=email).delete()
        otp = ''.join(secrets.choice('0123456789') for _ in range(6))
        OTP.objects.create(email=email, otp=otp)

        # Synchronous email sending
        try:
            send_mail(
                subject='Your OTP Code',
                message=f'Your verification code is: {otp}',
                from_email=settings.DEFAULT_FROM_EMAIL,
                recipient_list=[email],
                fail_silently=True
            )
        except Exception as e:
            logger.error(f"Failed to send OTP email to {email}: {str(e)}")
            return Response({"error": "Failed to send OTP"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response({"detail": "OTP sent successfully"}, status=status.HTTP_200_OK)


class SendPasswordResetOTPView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'send_otp'

    def post(self, request):
        turnstile_token = request.data.get('cf_turnstile_response') or request.data.get('turnstile_token')
        ok, err_msg = verify_turnstile_token(request, turnstile_token, expected_action='password_reset')
        if not ok:
            return Response({"error": err_msg}, status=status.HTTP_403_FORBIDDEN)

        email = request.data.get('email')
        if not email:
            return Response({"error": "Email required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            validate_email(email)
        except ValidationError:
            return Response({"error": "Invalid email"}, status=status.HTTP_400_BAD_REQUEST)

        user_exists = User.objects.filter(email=email).exists()

        if user_exists:
            OTP.objects.filter(email=email).delete()
            otp = ''.join(secrets.choice('0123456789') for _ in range(6))
            OTP.objects.create(email=email, otp=otp)

            try:
                send_mail(
                    subject='Your Password Reset Code',
                    message=f'Your password reset code is: {otp}',
                    from_email=settings.DEFAULT_FROM_EMAIL,
                    recipient_list=[email],
                    fail_silently=True
                )
            except Exception as e:
                logger.error(f"Failed to send password reset OTP email to {email}: {str(e)}")

        return Response(
            {"detail": "If an account exists with this email, a password reset code has been sent."},
            status=status.HTTP_200_OK
        )


class ValidatePasswordResetOTPView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'validate_otp'

    def post(self, request):
        email = request.data.get('email')
        otp = request.data.get('otp')

        if not email or not otp:
            return Response({"error": "Email and OTP are required"}, status=status.HTTP_400_BAD_REQUEST)

        # Rate limiting check
        allowed, error_msg = check_rate_limit(
            OTP_ATTEMPT_CACHE_PREFIX,
            email,
            MAX_OTP_ATTEMPTS,
            OTP_ATTEMPT_TIMEOUT
        )
        if not allowed:
            return Response({"error": error_msg}, status=status.HTTP_429_TOO_MANY_REQUESTS)

        try:
            User.objects.get(email=email)
        except User.DoesNotExist:
            # Return generic error to prevent user enumeration
            return Response({"error": "Invalid or expired OTP"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            otp_record = OTP.objects.get(
                email=email,
                otp=otp,
                created_at__gte=timezone.now() - timedelta(minutes=30)
            )
        except OTP.DoesNotExist:
            return Response({"error": "Invalid or expired OTP"}, status=status.HTTP_400_BAD_REQUEST)

        reset_token = build_password_reset_token(email)
        otp_record.delete()

        # Clear rate limiting on success
        delete_cache(f"{OTP_ATTEMPT_CACHE_PREFIX}{email}")

        return Response({"reset_token": reset_token}, status=status.HTTP_200_OK)


class ResetPasswordView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'reset_password'

    def post(self, request):
        reset_token = request.data.get('reset_token')
        new_password = request.data.get('new_password')

        if not reset_token or not new_password:
            return Response({"error": "Reset token and new password are required"}, status=status.HTTP_400_BAD_REQUEST)

        token_payload = parse_password_reset_token(reset_token)
        if token_payload is None:
            return Response({"error": "Invalid or expired reset token"}, status=status.HTTP_400_BAD_REQUEST)

        email = token_payload.get('email')
        if not email:
            return Response({"error": "Invalid reset token"}, status=status.HTTP_400_BAD_REQUEST)

        if is_token_used(reset_token):
            return Response({"error": "Reset token has already been used"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            return Response({"error": "Invalid reset token"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            validate_password(new_password, user=user)
        except ValidationError as exc:
            return Response({"error": exc.messages[0]}, status=status.HTTP_400_BAD_REQUEST)

        user.set_password(new_password)
        user.save(update_fields=['password'])

        mark_token_used(reset_token)

        return Response({"detail": "Password reset successfully"}, status=status.HTTP_200_OK)


class UsernameCheckView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'check_username'

    def get(self, request):
        username = request.query_params.get('username', '')
        if not re.match(settings.USERNAME_REGEX, username):
            return Response({"valid": False, "error": "Invalid username format."})

        if username.lower() in settings.RESERVED_USERNAMES:
            return Response({"valid": False, "error": "This username is reserved."})

        if User.objects.filter(username=username).exists():
            return Response({"valid": False, "error": "Username already taken."})

        return Response({"valid": True})


class RegisterView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'register'

    def post(self, request):
        turnstile_token = request.data.get('cf_turnstile_response') or request.data.get('turnstile_token')
        ok, err_msg = verify_turnstile_token(request, turnstile_token, expected_action='signup')
        if not ok:
            return Response({"error": err_msg}, status=status.HTTP_403_FORBIDDEN)

        ip_ok, ip_err = _check_signup_ip_limit(request)
        if not ip_ok:
            return Response({"error": ip_err}, status=status.HTTP_429_TOO_MANY_REQUESTS)

        serializer = UserSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        hygiene_error = validate_registration_email(data['email'])
        if hygiene_error:
            return Response({"error": hygiene_error}, status=status.HTTP_400_BAD_REQUEST)

        allowed, error_msg = check_rate_limit(
            OTP_ATTEMPT_CACHE_PREFIX,
            data['email'],
            MAX_OTP_ATTEMPTS,
            OTP_ATTEMPT_TIMEOUT
        )
        if not allowed:
            return Response({"error": error_msg}, status=status.HTTP_429_TOO_MANY_REQUESTS)

        try:
            otp_record = OTP.objects.get(
                email=data['email'],
                otp=data['otp'],
                created_at__gte=timezone.now() - timedelta(minutes=30)
            )
        except OTP.DoesNotExist:
            return Response({"error": "Invalid or expired OTP"}, status=status.HTTP_400_BAD_REQUEST)

        # Check for existing users
        if User.objects.filter(username=data['username']).exists():
            return Response({"error": "Username already exists"}, status=status.HTTP_400_BAD_REQUEST)

        # Create user
        user = serializer.save()
        _record_signup_ip(request)
        _record_user_auth_metadata(user, method='email', request=request, is_new=True)
        SandboxBootstrapService.ensure_personal_workspace(user)
        otp_record.delete()

        delete_cache(f"{OTP_ATTEMPT_CACHE_PREFIX}{data['email']}")

        return Response(build_auth_payload(user), status=status.HTTP_201_CREATED)


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'login'

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user = serializer.validated_data['user']
        _record_user_auth_metadata(user)
        return Response(build_auth_payload(user), status=status.HTTP_200_OK)


class LogoutView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        try:
            refresh_token = request.data.get('refresh')
            if refresh_token:
                token = RefreshToken(refresh_token)
                token.blacklist()
        except Exception as e:
            logger.error(f"Error blacklisting token: {str(e)}")

        return Response({"detail": "Successfully logged out"}, status=status.HTTP_200_OK)


class VerifyTokenView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        """Verify if the current token is valid and return user data"""
        return Response({
            'valid': True,
            'user': UserSerializer(request.user).data
        }, status=status.HTTP_200_OK)


class SocialLoginView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'login'
    serializer_class = SocialAuthSerializer

    def post(self, request):
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)

        provider = serializer.validated_data['provider']
        access_token = serializer.validated_data['access_token']

        try:
            # Load backend
            backend = load_backend(
                load_strategy(request),
                provider,
                redirect_uri=None
            )
        except MissingBackend:
            return Response(
                {'error': 'Invalid provider'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            # Authenticate user
            existing_emails = set(User.objects.filter(social_auth__provider=provider).values_list('pk', flat=True))
            user = backend.do_auth(access_token)
            is_new = bool(user and user.pk not in existing_emails and (timezone.now() - user.date_joined) < timedelta(seconds=60))
        except (AuthTokenError, AuthForbidden) as e:
            logger.warning(f"Social auth failed for provider {provider}: {str(e)}")
            return Response(
                {'error': 'Authentication failed'},
                status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as e:
            logger.error(f"Unexpected error in social auth: {str(e)}")
            return Response(
                {'error': 'Authentication failed'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if user and user.is_active:
            method_name = 'google' if 'google' in str(provider).lower() else str(provider)
            _record_user_auth_metadata(user, method=method_name, request=request, is_new=is_new)
            SandboxBootstrapService.ensure_personal_workspace(user)
            return Response(build_auth_payload(user), status=status.HTTP_200_OK)

        return Response(
            {'error': 'Authentication failed'},
            status=status.HTTP_400_BAD_REQUEST
        )


def _is_allowed_frontend_origin(origin):
    if not origin:
        return False
    allowed_origins = set(getattr(settings, 'CORS_ALLOWED_ORIGINS', [])) | {settings.FRONTEND_BASE_URL}
    if origin in allowed_origins:
        return True
    for pattern in getattr(settings, 'CORS_ALLOWED_ORIGIN_REGEXES', []):
        if re.match(pattern, origin):
            return True
    return False


def _valid_oauth_nonce(nonce):
    return isinstance(nonce, str) and 16 <= len(nonce) <= 128 and bool(re.fullmatch(r'[A-Za-z0-9_-]+', nonce))


class GithubOAuthStartView(APIView):
    """Initiate GitHub OAuth authentication flow."""
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'oauth_start'

    def get(self, request):
        from urllib.parse import urlencode
        from django.conf import settings as dj_settings
        from django.shortcuts import redirect
        from django.urls import reverse

        client_id = dj_settings.SOCIAL_AUTH_GITHUB_KEY
        if not client_id:
            return Response({"error": "GitHub OAuth client ID not configured"}, status=500)

        req_origin = (request.GET.get('origin') or '').strip()
        target_origin = req_origin if _is_allowed_frontend_origin(req_origin) else dj_settings.FRONTEND_BASE_URL
        token = request.GET.get('token') or ''
        nonce = (request.GET.get('nonce') or '').strip()
        state_payload = {'origin': target_origin, 'token': token}
        if _valid_oauth_nonce(nonce):
            state_payload['nonce'] = nonce
        state = 'ghlogin:' + signing.dumps(state_payload, salt='github_oauth_login')

        redirect_uri = getattr(dj_settings, 'GITHUB_REDIRECT_URI', None) or os.getenv('GITHUB_REDIRECT_URI', '').strip() or request.build_absolute_uri(reverse('github_oauth_callback'))

        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": "repo,user",
            "state": state,
        }

        auth_url = f"https://github.com/login/oauth/authorize?{urlencode(params)}"
        response = redirect(auth_url)
        response["Cross-Origin-Opener-Policy"] = "unsafe-none"
        return response


class GithubOAuthResultView(APIView):
    """One-time fallback retrieval of GitHub OAuth login result when popup postMessage is unavailable."""
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'oauth_callback'

    def get(self, request):
        nonce = (request.GET.get('nonce') or '').strip()
        if not _valid_oauth_nonce(nonce):
            return Response({'error': 'Invalid nonce'}, status=status.HTTP_400_BAD_REQUEST)
        cache_key = f"github-oauth-result:{nonce}"
        payload = get_cache(cache_key)
        if not payload:
            return Response({'status': 'pending'}, status=status.HTTP_404_NOT_FOUND)
        delete_cache(cache_key)
        return Response(payload, status=status.HTTP_200_OK)


class GithubOAuthCallbackView(APIView):
    """Complete GitHub OAuth authentication flow and notify parent window."""
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'oauth_callback'

    def _render_popup_response(self, request, payload, status_code=200, target_origin=None, nonce=None):
        import json
        from django.http import HttpResponse

        req_origin = target_origin or request.headers.get("Origin") or request.GET.get("origin")
        resolved_origin = req_origin if _is_allowed_frontend_origin(req_origin) else settings.FRONTEND_BASE_URL
        target_origin_json = json.dumps(resolved_origin)

        payload_with_source = {**payload, "source": "github-oauth"}
        if _valid_oauth_nonce(nonce):
            set_cache(f"github-oauth-result:{nonce}", payload_with_source, timeout=120)
        payload_str = json.dumps(payload_with_source).replace("<", "\\u003c")
        status_message = "Authentication failed. Closing..." if payload.get("error") else "Authentication complete. Redirecting..."

        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Authentication Redirect</title>
        </head>
        <body>
            <p>{status_message}</p>
            <script>
                try {{
                    const payload = {payload_str};
                    if (window.opener) {{
                        window.opener.postMessage(payload, {target_origin_json});
                    }}
                }} catch (e) {{
                    console.error("Failed to postMessage:", e);
                }}
                setTimeout(function() {{
                    window.close();
                }}, 150);
            </script>
        </body>
        </html>
        """
        response = HttpResponse(html_content, status=status_code)
        response["Cross-Origin-Opener-Policy"] = "unsafe-none"
        return response

    def get(self, request):
        import requests
        from django.conf import settings as dj_settings
        from django.urls import reverse

        from .github_connection import PREFIX, complete_github_connection
        if request.GET.get('state', '').startswith(PREFIX):
            return complete_github_connection(request)

        oauth_error = request.GET.get('error_description') or request.GET.get('error')
        if oauth_error:
            return self._render_popup_response(request, {"error": oauth_error}, status_code=400)

        code = request.GET.get('code')
        state = request.GET.get('state') or ''
        target_origin = None
        nonce = None
        if state.startswith('ghlogin:'):
            try:
                state_payload = signing.loads(state[len('ghlogin:'):], salt='github_oauth_login', max_age=600)
                target_origin = state_payload.get('origin')
                nonce = state_payload.get('nonce')
            except signing.BadSignature:
                return self._render_popup_response(request, {"error": "Invalid or expired OAuth state"}, status_code=400)

        if not code:
            return self._render_popup_response(request, {"error": "No code provided"}, status_code=400, target_origin=target_origin, nonce=nonce)

        client_id = dj_settings.SOCIAL_AUTH_GITHUB_KEY
        client_secret = dj_settings.SOCIAL_AUTH_GITHUB_SECRET
        redirect_uri = getattr(dj_settings, 'GITHUB_REDIRECT_URI', None) or os.getenv('GITHUB_REDIRECT_URI', '').strip() or request.build_absolute_uri(reverse('github_oauth_callback'))

        # 1. Exchange code for access token
        token_url = "https://github.com/login/oauth/access_token"
        headers = {"Accept": "application/json"}
        data = {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
        }
        res = requests.post(token_url, headers=headers, data=data)
        if res.status_code != 200:
            return self._render_popup_response(request, {"error": "Failed to exchange authorization code"}, status_code=400, target_origin=target_origin, nonce=nonce)

        res_data = res.json()
        access_token = res_data.get("access_token")
        if not access_token:
            return self._render_popup_response(
                request,
                {"error": res_data.get("error_description", "No access token in response")},
                status_code=400,
                target_origin=target_origin,
                nonce=nonce,
            )

        # 2. Fetch user profile from GitHub
        user_url = "https://api.github.com/user"
        user_headers = {
            "Authorization": f"token {access_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        user_res = requests.get(user_url, headers=user_headers)
        if user_res.status_code != 200:
            return self._render_popup_response(request, {"error": "Failed to fetch user profile from GitHub"}, status_code=400, target_origin=target_origin, nonce=nonce)

        github_user = user_res.json()
        github_uid = str(github_user.get("id"))
        github_username = github_user.get("login")
        github_email = github_user.get("email")

        # Fetch verified email from GitHub API if not public in profile
        if not github_email:
            try:
                emails_res = requests.get("https://api.github.com/user/emails", headers=user_headers, timeout=10)
                if emails_res.status_code == 200:
                    emails_data = emails_res.json()
                    for em in emails_data:
                        if em.get("primary") and em.get("verified"):
                            github_email = em.get("email")
                            break
                    if not github_email:
                        for em in emails_data:
                            if em.get("verified"):
                                github_email = em.get("email")
                                break
            except Exception:
                pass

        is_synthetic_email = False
        if not github_email:
            github_email = f"{github_username}-{github_uid}@users.noreply.github.com"
            is_synthetic_email = True

        # 3. Associate or login
        user = None
        if state:
            # Decode JWT token to get the linking user
            try:
                from rest_framework_simplejwt.tokens import AccessToken
                decoded = AccessToken(state)
                user_id = decoded.get('user_id')
                from django.contrib.auth import get_user_model
                User = get_user_model()
                user = User.objects.get(pk=user_id)
            except Exception:
                logger.exception("Failed to decode token state in GitHub OAuth callback")

        is_new_github_user = False
        if not user:
            # If not linking, check if there's a UserSocialAuth with this github_uid
            from social_django.models import UserSocialAuth
            social_auth = UserSocialAuth.objects.filter(provider='github', uid=github_uid).first()
            if social_auth:
                user = social_auth.user
            else:
                # Get or create user
                from django.contrib.auth import get_user_model
                User = get_user_model()
                # Only match by verified email, NEVER match by username to prevent Account Takeover
                if not is_synthetic_email:
                    user = User.objects.filter(email__iexact=github_email).first()
                if not user:
                    # Create new user with unique username
                    candidate_username = github_username
                    while User.objects.filter(username__iexact=candidate_username).exists():
                        candidate_username = f"{github_username}_{secrets.token_hex(2)}"
                    user = User.objects.create_user(
                        username=candidate_username,
                        email=github_email,
                        password=secrets.token_urlsafe(32)
                    )
                    is_new_github_user = True

        # 4. Create / update the single GitHub link for this account.
        from social_django.models import UserSocialAuth
        from .github_connection import replace_other_github_connections

        replace_other_github_connections(user, github_uid)
        social_auth = UserSocialAuth.objects.filter(
            user=user, provider='github', uid=github_uid
        ).first()
        if not social_auth:
            social_auth = UserSocialAuth(user=user, provider='github', uid=github_uid)
        social_auth.extra_data = {
            "access_token": access_token,
            "login": github_username,
            "id": github_uid,
            "created_at": github_user.get("created_at"),
            "scope": res_data.get("scope", user_res.headers.get("X-OAuth-Scopes", ""))
        }
        social_auth.save()

        SandboxBootstrapService.ensure_personal_workspace(user)
        _record_user_auth_metadata(user, method='github', is_new=is_new_github_user)

        # 5. Render script payload to postMessage back to frontend
        auth_payload = build_auth_payload(user)
        return self._render_popup_response(request, auth_payload, status_code=200, target_origin=target_origin, nonce=nonce)


class TokenRefreshView(APIView):
    """Refreshes access token only if the user exists and is active in database."""
    permission_classes = [permissions.AllowAny]
    throttle_scope = 'token_refresh'

    def post(self, request):
        refresh_token = request.data.get('refresh')
        if not refresh_token:
            return Response({'error': 'Refresh token is required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            from rest_framework_simplejwt.tokens import RefreshToken
            token = RefreshToken(refresh_token)
            user_id = token.get('user_id')
            User = get_user_model()
            user = User.objects.filter(uuid=user_id).first()
            if not user or not user.is_active:
                return Response({'error': 'User not found or inactive'}, status=status.HTTP_401_UNAUTHORIZED)
            access = str(token.access_token)
            return Response({'access': access})
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_401_UNAUTHORIZED)

