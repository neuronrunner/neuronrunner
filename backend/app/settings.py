import asyncio.constants
asyncio.constants.SSL_SHUTDOWN_TIMEOUT = 0.1

import json
import os
import sys
from datetime import timedelta
from os import getenv
from pathlib import Path

from corsheaders.defaults import default_headers
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Load environment variables
load_dotenv(BASE_DIR / '.env', override=True)
_extra_env = getenv('NEURONRUNNER_ENV_FILE', '').strip()
if _extra_env and Path(_extra_env).is_file():
    load_dotenv(_extra_env, override=True)

DEBUG = getenv('DEBUG', 'False').lower() in ('1', 'true', 't')
ENABLE_ADMIN = (getenv('ENABLE_ADMIN') or 'false').lower() in ('1', 'true', 't')
FRONTEND_BASE_URL = getenv('FRONTEND_BASE_URL', 'http://localhost:3000').rstrip('/')
# Public backend origin used by OAuth Client ID Metadata Documents (CIMD).
MCP_OAUTH_PUBLIC_BASE_URL = getenv('MCP_OAUTH_PUBLIC_BASE_URL', '').rstrip('/')
MCP_OAUTH_CLIENTS = json.loads(getenv('MCP_OAUTH_CLIENTS') or '{}')

_secret_key_env = getenv('SECRET_KEY', '').strip()
# Treat the .env.example placeholder as unset so it is never used as a real key.
if _secret_key_env.startswith('change-me'):
    _secret_key_env = ''
SECRET_KEY = _secret_key_env or ('django-insecure-dev-key' if (DEBUG or 'test' in sys.argv) else None)
if not SECRET_KEY:
    raise ValueError("SECRET_KEY environment variable is required in production!")

_allowed_hosts_env = getenv('ALLOWED_HOSTS', '').strip()
if _allowed_hosts_env:
    ALLOWED_HOSTS = [h.strip() for h in _allowed_hosts_env.split(',') if h.strip()]
elif DEBUG:
    ALLOWED_HOSTS = ['*']
else:
    ALLOWED_HOSTS = ['localhost', '127.0.0.1']

INSTALLED_APPS = [
    'daphne',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.admin',
    'rest_framework',
    'corsheaders',
    'social_django',
    'channels',
    'model',
    'authentication',
    'chat',
    'user',
    'openai_compat',
    'mcp',
    'sandbox.apps.SandboxConfig',
]

MIDDLEWARE = [
    'app.timing_middleware.RequestTimingMiddleware',
    'app.db_retry_middleware.DatabaseWarmupMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'sandbox.middleware.SandboxRuntimeMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'app.urls'
ASGI_APPLICATION = 'app.asgi.application'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'app.wsgi.application'

# Embeddings must stay in one named space. Leave empty to use full-text search.
MEMORY_EMBEDDING_MODEL = getenv('MEMORY_EMBEDDING_MODEL') or (
    'openrouter:' + getenv('OPENROUTER_VECTOR_MODEL')
    if getenv('OPENROUTER_VECTOR_MODEL')
    else ''
)

# Database configuration
if 'test' in sys.argv:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': ':memory:',
        }
    }

    class DisableMigrations:
        def __contains__(self, item):
            return True

        def __getitem__(self, item):
            return None

    MIGRATION_MODULES = DisableMigrations()
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': getenv('DB_DATABASE', 'neuronrunner'),
            'USER': getenv('DB_USER', 'postgres'),
            'PASSWORD': getenv('DB_PASSWORD', 'postgres'),
            'HOST': getenv('DB_HOST', 'localhost'),
            'PORT': getenv('DB_PORT', '5432'),
            'CONN_MAX_AGE': int(getenv('DB_CONN_MAX_AGE', '60')),
            'CONN_HEALTH_CHECKS': True,
        }
    }

REDIS_URL = getenv('REDIS_URL', '').strip()
if REDIS_URL and 'test' not in sys.argv:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': REDIS_URL,
        }
    }
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {
                'hosts': [REDIS_URL],
            },
        },
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        }
    }
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels.layers.InMemoryChannelLayer',
        },
    }

REST_FRAMEWORK = {
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'authentication.api_key_auth.ApiKeyAuthentication',
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
        'rest_framework.throttling.ScopedRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'anon': getenv('THROTTLE_ANON_RATE', '120/minute'),
        'user': getenv('THROTTLE_USER_RATE', '1200/minute'),
        'send_otp': getenv('THROTTLE_SEND_OTP_RATE', '5/minute'),
        'login': getenv('THROTTLE_LOGIN_RATE', '10/minute'),
        'register': getenv('THROTTLE_REGISTER_RATE', '10/minute'),
        'reset_password': getenv('THROTTLE_RESET_PASSWORD_RATE', '10/minute'),
        'validate_otp': getenv('THROTTLE_VALIDATE_OTP_RATE', '15/minute'),
        'token_refresh': getenv('THROTTLE_TOKEN_REFRESH_RATE', '30/minute'),
        'check_username': getenv('THROTTLE_CHECK_USERNAME_RATE', '60/minute'),
        'change_password': getenv('THROTTLE_CHANGE_PASSWORD_RATE', '10/minute'),
        'test_custom_model': getenv('THROTTLE_TEST_CUSTOM_MODEL_RATE', '10/minute'),
        'sandbox_clone': getenv('THROTTLE_SANDBOX_CLONE_RATE', '10/minute'),
        'file_upload': getenv('THROTTLE_FILE_UPLOAD_RATE', '20/minute'),
        'send_invitation': getenv('THROTTLE_SEND_INVITATION_RATE', '10/minute'),
        'oauth_callback': getenv('THROTTLE_OAUTH_CALLBACK_RATE', '15/minute'),
        'oauth_start': getenv('THROTTLE_OAUTH_START_RATE', '30/minute'),
    },
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer',
        'app.renderers.ServerSentEventRenderer',
        'rest_framework.renderers.BrowsableAPIRenderer',
    ],
    'TEST_REQUEST_DEFAULT_FORMAT': 'json',
}

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(hours=24),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=30),
    'AUTH_HEADER_TYPES': ('Bearer',),
    'USER_ID_FIELD': 'uuid',
    'USER_ID_CLAIM': 'user_id',
}

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_L10N = True
USE_TZ = True

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
AUTH_USER_MODEL = 'user.User'

# Email configuration
EMAIL_BACKEND = getenv('EMAIL_BACKEND', 'django.core.mail.backends.smtp.EmailBackend')
EMAIL_HOST = getenv('EMAIL_HOST')
EMAIL_PORT = getenv('EMAIL_PORT')
EMAIL_USE_TLS = True
EMAIL_HOST_USER = getenv('EMAIL_HOST_USER')
EMAIL_HOST_PASSWORD = getenv('EMAIL_HOST_PASSWORD')
DEFAULT_FROM_EMAIL = getenv('DEFAULT_FROM_EMAIL')

# Optional S3-compatible object storage (defaults to local filesystem)
AWS_ACCESS_KEY_ID = getenv('AWS_ACCESS_KEY_ID')
AWS_SECRET_ACCESS_KEY = getenv('AWS_SECRET_ACCESS_KEY')
AWS_STORAGE_BUCKET_NAME = getenv('AWS_STORAGE_BUCKET_NAME')
AWS_S3_REGION_NAME = getenv('AWS_S3_REGION_NAME')
AWS_S3_SIGNATURE_VERSION = 's3v4'
AWS_DEFAULT_ACL = 'public-read'
AWS_S3_ENDPOINT_URL = getenv('AWS_S3_ENDPOINT_URL')
AWS_S3_CUSTOM_DOMAIN = getenv('AWS_S3_CUSTOM_DOMAIN')

if AWS_S3_CUSTOM_DOMAIN:
    MEDIA_URL = f'https://{AWS_S3_CUSTOM_DOMAIN}/media/'
    STATIC_URL = f'https://{AWS_S3_CUSTOM_DOMAIN}/static/'
else:
    MEDIA_URL = '/media/'
    STATIC_URL = '/static/'

MEDIA_ROOT = BASE_DIR / 'media'
STATIC_ROOT = BASE_DIR / 'staticfiles'

_is_test = 'test' in sys.argv or 'pytest' in sys.modules

if _is_test:
    STORAGES = {
        'default': {'BACKEND': 'django.core.files.storage.InMemoryStorage'},
        'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
    }
elif AWS_STORAGE_BUCKET_NAME:
    STORAGES = {
        'default': {
            'BACKEND': 'storages.backends.s3boto3.S3Boto3Storage',
            'OPTIONS': {'location': 'media'},
        },
        'staticfiles': {
            'BACKEND': 'storages.backends.s3boto3.S3StaticStorage',
            'OPTIONS': {'location': 'static'},
        },
    }
else:
    STORAGES = {
        'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
        'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
    }

AWS_S3_MAX_PART_SIZE = 100 * 1024 * 1024
AWS_S3_MAX_FILE_SIZE = 150 * 1024 * 1024 * 1024
AWS_S3_PRESIGNED_URL_EXPIRATION = 3600

MAX_ACTIVE_INSTANCES = int(getenv('MAX_ACTIVE_INSTANCES', '5'))
INSTANCE_IDLE_TIMEOUT = int(getenv('INSTANCE_IDLE_TIMEOUT', '10'))
INSTANCE_MAX_LIFETIME = int(getenv('INSTANCE_MAX_LIFETIME', str(60 * 15)))

USERNAME_REGEX = r'^[a-zA-Z0-9_.]{3,30}$'
RESERVED_USERNAMES = ['admin', 'root', 'support', 'null', 'me', 'login', 'api']

CORS_ALLOW_ALL_ORIGINS = getenv('CORS_ALLOW_ALL_ORIGINS', '').lower() in ('1', 'true', 't')
CORS_ALLOW_CREDENTIALS = True
_cors_origins_env = getenv('CORS_ALLOWED_ORIGINS', '').strip()
CORS_ALLOWED_ORIGINS = [o.strip() for o in _cors_origins_env.split(',') if o.strip()]
for origin in [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
]:
    if origin not in CORS_ALLOWED_ORIGINS:
        CORS_ALLOWED_ORIGINS.append(origin)
if FRONTEND_BASE_URL and FRONTEND_BASE_URL not in CORS_ALLOWED_ORIGINS:
    CORS_ALLOWED_ORIGINS.append(FRONTEND_BASE_URL)

CORS_ALLOWED_ORIGIN_REGEXES = [
    r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
]

_csrf_origins_env = getenv('CSRF_TRUSTED_ORIGINS', '').strip()
CSRF_TRUSTED_ORIGINS = [o.strip() for o in _csrf_origins_env.split(',') if o.strip()]
for origin in CORS_ALLOWED_ORIGINS:
    if origin not in CSRF_TRUSTED_ORIGINS:
        CSRF_TRUSTED_ORIGINS.append(origin)

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
USE_X_FORWARDED_HOST = True
USE_X_FORWARDED_PORT = True
SECURE_REDIRECT_EXEMPT = [r'^health/?$', r'^$']

if not DEBUG:
    SECURE_SSL_REDIRECT = getenv('SECURE_SSL_REDIRECT', 'f').lower() in ('1', 'true', 't')
    SESSION_COOKIE_SECURE = getenv('SESSION_COOKIE_SECURE', 't').lower() in ('1', 'true', 't')
    CSRF_COOKIE_SECURE = getenv('CSRF_COOKIE_SECURE', 't').lower() in ('1', 'true', 't')
    SECURE_HSTS_SECONDS = int(getenv('SECURE_HSTS_SECONDS', '31536000'))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_CROSS_ORIGIN_OPENER_POLICY = 'same-origin-allow-popups'
    X_FRAME_OPTIONS = 'DENY'
else:
    SECURE_SSL_REDIRECT = False
    SESSION_COOKIE_SECURE = False
    CSRF_COOKIE_SECURE = False
    SECURE_HSTS_SECONDS = 0
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_CROSS_ORIGIN_OPENER_POLICY = 'same-origin-allow-popups'
    X_FRAME_OPTIONS = 'SAMEORIGIN'

CORS_EXPOSE_HEADERS = [
    'X-Request-ID',
    'X-Conversation-ID',
    'Content-Length',
    'Content-Range',
    'Content-Type',
    'Date',
]

CORS_ALLOW_HEADERS = list(default_headers) + [
    'cache-control',
    'pragma',
    'x-workspace-id',
    'x-sandbox-runtime',
    'x-request-id',
    'x-conversation-id',
    'x-selected-model',
    'x-stainless-os',
    'x-stainless-arch',
    'x-stainless-lang',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
    'x-stainless-package-version',
    'x-stainless-helper-method',
    'x-stainless-retry-count',
    'x-stainless-timeout',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
]

# OAuth2 settings (optional)
AUTHENTICATION_BACKENDS = (
    'social_core.backends.google.GoogleOAuth2',
    'social_core.backends.github.GithubOAuth2',
    'django.contrib.auth.backends.ModelBackend',
)

SOCIAL_AUTH_GOOGLE_OAUTH2_KEY = getenv('GOOGLE_CLIENT_ID')
SOCIAL_AUTH_GOOGLE_OAUTH2_SECRET = getenv('GOOGLE_CLIENT_SECRET')
SOCIAL_AUTH_GITHUB_KEY = getenv('GITHUB_CLIENT_ID')
SOCIAL_AUTH_GITHUB_SECRET = getenv('GITHUB_CLIENT_SECRET')
GITHUB_REDIRECT_URI = getenv('GITHUB_REDIRECT_URI', '').strip() or None
GITHUB_TOKEN = getenv('GITHUB_TOKEN')

DATA_UPLOAD_MAX_MEMORY_SIZE = 1048576000  # 1 GB
PROFILE_PICTURE_MAX_SIZE = 10 * 1024 * 1024  # 10 MB
APPEND_SLASH = True

# Optional LLM / Search integrations (users can also configure BYOK keys per workspace)
OPENROUTER_API_KEY = getenv('OPENROUTER_API_KEY')
OPENROUTER_BASE_URL = getenv('OPENROUTER_BASE_URL')
OPENAI_API_KEY = getenv('OPENAI_API_KEY', '').strip()
OPENAI_BASE_URL = getenv('OPENAI_BASE_URL', '').strip()
TAVILY_API_KEY = getenv('TAVILY_API_KEY', '').strip()

# Local MCP settings
MCP_STDIO_STARTUP_TIMEOUT = max(1, int(getenv('MCP_STDIO_STARTUP_TIMEOUT', '120')))
BUILTIN_BROWSER_ENABLED = getenv('BUILTIN_BROWSER_ENABLED', 'true').lower() not in ('0', 'false', 'no', 'off')
BUILTIN_BROWSER_TIMEOUT = max(1, int(getenv('BUILTIN_BROWSER_TIMEOUT', '60')))
BUILTIN_BROWSER_COMMAND = getenv('BUILTIN_BROWSER_COMMAND', 'npx -y @playwright/mcp@0.0.82')
REMOTE_ONLY_MCP = getenv('REMOTE_ONLY_MCP', 'true').lower() not in ('0', 'false', 'no', 'off')
MCP_URL_VALIDATION_ENABLED = getenv('MCP_URL_VALIDATION_ENABLED', 'true').lower() not in ('0', 'false', 'no', 'off')
MCP_ALLOW_PRIVATE_URLS = getenv('MCP_ALLOW_PRIVATE_URLS', 'false').lower() in ('1', 'true', 'yes', 'on')

# Sandbox Runtime Provider (defaults to local Docker in self-hosted OSS mode)
SANDBOX_PROVIDER = (getenv('SANDBOX_PROVIDER', 'docker') or 'docker').strip().lower()
DOCKER_SANDBOX_IMAGE = getenv('DOCKER_SANDBOX_IMAGE', 'neuronrunner-sandbox:latest').strip()
DOCKER_SANDBOX_FALLBACK_IMAGE = getenv('DOCKER_SANDBOX_FALLBACK_IMAGE', 'python:3.11-slim').strip()
DOCKER_SANDBOX_NETWORK = getenv('DOCKER_SANDBOX_NETWORK', '').strip()
LOCAL_WORKSPACE_ROOT = getenv('LOCAL_WORKSPACE_ROOT', str(BASE_DIR / 'workspaces')).strip()
# Host path of LOCAL_WORKSPACE_ROOT as seen by the Docker daemon. Only needed when the
# backend runs in a container and its bind mounts cannot be auto-detected.
DOCKER_SANDBOX_HOST_WORKSPACE_ROOT = getenv('DOCKER_SANDBOX_HOST_WORKSPACE_ROOT', '').strip()
# Running Docker sandboxes allowed per workspace (default runtime plus named ones).
# 0 removes the limit.
DOCKER_SANDBOX_MAX_CONCURRENT = max(0, int(getenv('DOCKER_SANDBOX_MAX_CONCURRENT', '3') or 0))
PREVIEW_PROXY_BASE_URL = getenv('PREVIEW_PROXY_BASE_URL', 'http://127.0.0.1:8090').rstrip('/')
PREVIEW_PROXY_PORT = int(getenv('PREVIEW_PROXY_PORT', '8090'))

SANDBOX_IDLE_TIMEOUT_DEFAULT = int(getenv('SANDBOX_IDLE_TIMEOUT_DEFAULT', '1800'))
SANDBOX_IDLE_TIMEOUT_MIN = 5
SANDBOX_IDLE_TIMEOUT_LIMITS = {
    'default': {'cpu': 43200},
    'free': {'cpu': 43200},
    'pro': {'cpu': 43200},
    'enterprise': {'cpu': 43200},
}

# Optional Cloudflare Turnstile bot protection (disabled by default for self-hosted deployments)
TURNSTILE_SECRET = getenv('TURNSTILE_SECRET', '').strip()
TURNSTILE_REQUIRED = getenv('TURNSTILE_REQUIRED', 'false').lower() in ('1', 'true', 't')
TURNSTILE_HOSTNAMES = [
    h.strip().lower()
    for h in getenv('TURNSTILE_HOSTNAMES', 'localhost,127.0.0.1').split(',')
    if h.strip()
]
MAX_SIGNUPS_PER_IP_PER_DAY = int(getenv('MAX_SIGNUPS_PER_IP_PER_DAY', '20'))
SIGNUP_IP_WINDOW_SECONDS = int(getenv('SIGNUP_IP_WINDOW_SECONDS', '86400'))

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '[{asctime}] {levelname}: {name}.{message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {'level': 'INFO', 'class': 'logging.StreamHandler', 'formatter': 'verbose'},
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO',
    },
}

# Optional dedicated Fernet key; otherwise derived from SECRET_KEY with a BYOK-specific domain.
WORKSPACE_KEYS_ENCRYPTION_KEY = getenv('WORKSPACE_KEYS_ENCRYPTION_KEY', '').strip()

# Optional extension plugin hook (no-op unless NEURONRUNNER_EXTENSION_PLUGIN is set)
from core.extensions import load_extension_plugin as _load_extension_plugin, registry as _ext_registry

if _load_extension_plugin(globals()):
    for _app in _ext_registry.app.extra_installed_apps:
        if _app not in INSTALLED_APPS:
            INSTALLED_APPS.append(_app)
    for _hdr in _ext_registry.app.extra_cors_headers:
        if _hdr not in CORS_ALLOW_HEADERS:
            CORS_ALLOW_HEADERS.append(_hdr)
    for _host in _ext_registry.app.extra_allowed_hosts:
        if _host not in ALLOWED_HOSTS:
            ALLOWED_HOSTS.append(_host)
    for _origin in _ext_registry.app.extra_cors_origins:
        if _origin not in CORS_ALLOWED_ORIGINS:
            CORS_ALLOWED_ORIGINS.append(_origin)
        if _origin not in CSRF_TRUSTED_ORIGINS:
            CSRF_TRUSTED_ORIGINS.append(_origin)
