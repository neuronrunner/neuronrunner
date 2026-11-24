---
title: Configuration
description: Environment variables for the backend and frontend.
---

The backend reads its settings from environment variables. With Docker Compose, values come from `backend/.env.example` first and are overridden by `backend/.env` when that file exists. The frontend reads `VITE_*` variables at **build time**.

## Production checklist

Before running NeuronRunner for anyone but yourself:

- [ ] Set a long random `SECRET_KEY`:
  `python3 -c "import secrets; print(secrets.token_urlsafe(50))"`
- [ ] Set `DEBUG=False`.
- [ ] Set `ALLOWED_HOSTS`, `FRONTEND_BASE_URL`, `CORS_ALLOWED_ORIGINS` and `CSRF_TRUSTED_ORIGINS` to your real domains.
- [ ] Set `PREVIEW_PROXY_BASE_URL` to a URL on a **different origin** than the app (for example `https://preview.example.com`).
- [ ] Configure a real email backend so sign-in codes can be delivered.
- [ ] Put the frontend, API and preview proxy behind HTTPS.

> [!IMPORTANT]
> BYOK provider keys are encrypted with `WORKSPACE_KEYS_ENCRYPTION_KEY`, or with a key derived from `SECRET_KEY` when it is empty. Changing either one makes stored keys unreadable, so keep them stable and backed up.

## Core

| Variable | Description | Default |
| --- | --- | --- |
| `SECRET_KEY` | Django secret key. Required in production. | — |
| `DEBUG` | Debug mode. | `False` |
| `ALLOWED_HOSTS` | Comma-separated host names the API answers to. | — |
| `FRONTEND_BASE_URL` | Public URL of the frontend, used for CORS and OAuth redirects. | `http://localhost:3000` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins allowed to call the API. | — |
| `CSRF_TRUSTED_ORIGINS` | Comma-separated trusted origins for CSRF. | — |
| `NEURONRUNNER_ENV_FILE` | Path to an extra env file loaded at startup. | — |

## Database and cache

| Variable | Description | Default |
| --- | --- | --- |
| `DB_ENGINE` | `django.db.backends.postgresql` or `django.db.backends.sqlite3`. | `sqlite3` outside Compose |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD` | PostgreSQL connection. | `localhost`, `5432`, `neuronrunner`, `postgres`, `postgres` |
| `REDIS_URL` | Redis for Channels, cache, WebSocket tickets and preview tokens. | `redis://127.0.0.1:6379/0` |

## Sandbox

See [Sandboxes](./02-sandbox.md) for details.

| Variable | Description | Default |
| --- | --- | --- |
| `SANDBOX_PROVIDER` | Sandbox runtime. | `docker` |
| `DOCKER_SANDBOX_IMAGE` | Image used for workspace containers. | `neuronrunner-sandbox:latest` |
| `DOCKER_SANDBOX_FALLBACK_IMAGE` | Image used when the preferred one is not available. | `python:3.11-slim` |
| `DOCKER_SANDBOX_NETWORK` | Docker network to attach sandboxes to. | — |
| `DOCKER_SANDBOX_MAX_CONCURRENT` | Running sandboxes allowed per workspace, counting the default runtime and named ones. `0` removes the limit. See [Several runtimes per workspace](./02-sandbox.md#several-runtimes-per-workspace). | `3` |
| `LOCAL_WORKSPACE_ROOT` | Host directory holding workspace files. | `backend/workspaces` |
| `SANDBOX_IDLE_TIMEOUT_DEFAULT` | Seconds of inactivity before a sandbox is stopped. | `1800` |
| `PREVIEW_PROXY_BASE_URL` | Public URL of the preview proxy. | `http://127.0.0.1:8090` |
| `PREVIEW_PROXY_PORT` | Port the preview proxy listens on. | `8090` |

## Models and tools

| Variable | Description | Default |
| --- | --- | --- |
Chat never uses these: every workspace connects its own key or subscription (see [Models & Provider Keys](../03-features/01-models-and-byok.md)).

| Variable | Description | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | Used for `openrouter:` memory embeddings and by the admin model-catalog commands. | —, `https://openrouter.ai/api/v1` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Used for `openai:` memory embeddings. | — |
| `TAVILY_API_KEY` | Enables the web search tool. | — |
| `MEMORY_EMBEDDING_MODEL` | Embedding model for semantic memory, e.g. `openrouter:openai/text-embedding-3-small`. Empty means full-text search. | — |
| `WORKSPACE_KEYS_ENCRYPTION_KEY` | Dedicated Fernet key for the BYOK vault. | derived from `SECRET_KEY` |

## MCP and browser

| Variable | Description | Default |
| --- | --- | --- |
| `REMOTE_ONLY_MCP` | Only allow remote HTTP/SSE MCP servers to be added by users. | `true` |
| `MCP_URL_VALIDATION_ENABLED` | Validate MCP server URLs before connecting. | `true` |
| `MCP_ALLOW_PRIVATE_URLS` | Allow MCP servers on private network addresses. | `false` |
| `BUILTIN_BROWSER_ENABLED` | Enable the built-in Playwright browser tool. | `true` |

## Authentication and email

| Variable | Description | Default |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. | — |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI` | GitHub sign-in and repository access. | — |
| `EMAIL_BACKEND`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `DEFAULT_FROM_EMAIL` | Outgoing email for sign-in codes and invitations. | console backend |
| `TURNSTILE_REQUIRED`, `TURNSTILE_SECRET`, `TURNSTILE_HOSTNAMES` | Cloudflare Turnstile on auth endpoints. | disabled |
| `MAX_SIGNUPS_PER_IP_PER_DAY` | Sign-up rate limit per IP. | `20` |

## Frontend

Set these in `frontend/.env.local` for development, or as build args in `docker-compose.yml`.

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_API_URL` | URL of the backend API. | `http://localhost:8000` |
| `VITE_GOOGLE_CLIENT_ID` | Google client ID; leave empty to hide Google sign-in. | — |
| `VITE_TURNSTILE_SITE_KEY` | Turnstile site key. | — |
| `VITE_DOCS_ENABLED` | Serve these docs at `/docs`. | `false` |
