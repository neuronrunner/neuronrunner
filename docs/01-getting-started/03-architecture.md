---
title: Architecture
description: How the frontend, backend, sandboxes and preview proxy fit together.
---

NeuronRunner is a React single-page app talking to a Django ASGI backend. The backend stores state in PostgreSQL and Redis and runs one Docker container per workspace.

```text
React 19 + Vite web app
  Chat | Files | Editor | Terminal | Git & PRs | Browser
        │  HTTP (REST / SSE) + WebSocket
        ▼
Django 5.2 ASGI API (Daphne + Channels)
  chat | sandbox | mcp | model | authentication | user
   │              │                 │
   ▼              ▼                 ▼
PostgreSQL     Redis             Docker Engine ──► Preview proxy (:8090)
+ pgvector     channels, cache,  one container
               WS tickets,       per workspace
               preview tokens
```

## Backend apps

| App | Responsibility |
| --- | --- |
| `authentication` | JWT auth, email one-time codes, Google and GitHub OAuth, optional Turnstile |
| `chat` | Streaming LLM chat, tool calling, memory, notes, attachments |
| `sandbox` | Docker runtime, PTY terminal, port previews, Git, BYOK keys, secrets |
| `mcp` | Model Context Protocol client, OAuth and tool execution |
| `model` | Model catalog and reasoning settings |
| `user` | User model, profiles, API keys |
| `core` | Extension registry (see [Extensions](../04-extending/01-extensions.md)) |

## Request flow

1. The browser sends a chat message over HTTP; the reply streams back with Server-Sent Events.
2. The chat agent calls tools (read file, run command, Git, MCP tools...). Sandbox tools execute inside the workspace container through the Docker API.
3. The terminal is a WebSocket served by Django Channels. Each connection uses a one-time signed ticket stored in Redis.
4. Port previews go through the separate preview proxy so sandbox apps never share an origin, cookies or storage with NeuronRunner itself.

## Isolation

- Each workspace container runs with CPU, memory and PID limits (`--pids-limit 256`) and `no-new-privileges`.
- Files live in a persistent volume mounted at `/workspace`; stopping a container does not delete them.
- Workspace secrets are encrypted at rest and injected into the container as environment variables.
