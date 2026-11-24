---
title: Quickstart
description: Run NeuronRunner locally with Docker Compose in a few minutes.
badge: 5 min
---

This guide starts the full stack (PostgreSQL, Redis, backend, preview proxy and frontend) with Docker Compose.

## Prerequisites

- Docker Engine and Docker Compose v2
- At least one LLM API key (OpenRouter, OpenAI, Anthropic, Gemini) or a local Ollama instance

## 1. Clone the repository

```bash
git clone https://github.com/neuronrunner/neuronrunner.git
cd neuronrunner
cp backend/.env.example backend/.env
```

`backend/.env` is optional for a local try-out. Without it, Compose uses the defaults from `backend/.env.example`: debug mode with an insecure development `SECRET_KEY`.

> [!WARNING]
> Before exposing NeuronRunner beyond your own machine, set a real `SECRET_KEY` and `DEBUG=False`. See [Configuration](../02-self-hosting/01-configuration.md).

## 2. Build the sandbox image

```bash
docker build -f Dockerfile.sandbox -t neuronrunner-sandbox:latest .
```

This image is what every workspace container runs. If you skip this step, NeuronRunner falls back to `python:3.11-slim`, which works but has far fewer tools installed.

## 3. Start the stack

```bash
docker compose up -d --build
```

| Service | URL |
| --- | --- |
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000 |
| Port preview proxy | http://localhost:8090 |

## 4. Sign in and connect your AI

1. Open http://localhost:3000 and create an account. With the default console email backend, the one-time code is printed in the backend logs: `docker compose logs -f backend`.
2. On first sign-in you land on the **Hello** page. Connect an API key (OpenRouter, OpenAI, Google Gemini, DeepSeek, Groq or any OpenAI-compatible endpoint) or sign in with a Claude, ChatGPT or Antigravity subscription, then pick the models you want.
3. Start a chat and ask the agent to do something in the sandbox, for example *"create a Vite React app and start the dev server"*.

> [!TIP]
> No credit yet? Pick OpenRouter and filter for free models to try NeuronRunner at no cost. See [Models & Provider Keys](../03-features/01-models-and-byok.md).

> [!TIP]
> When the agent starts a server inside the sandbox, the preview opens through the proxy on port 8090, so the app runs on its own origin, separate from NeuronRunner.
