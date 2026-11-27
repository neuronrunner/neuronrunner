---
title: Models & Provider Keys
description: Every workspace brings its own API key or subscription.
---

Neuron Runner does not ship a model of its own: each workspace connects the AI it wants to use, and pays that provider directly.

## The Hello page

A workspace without a usable model is sent to `/hello` before its first chat. There an owner or admin can:

- **Add an API key** for OpenRouter, OpenAI, Google Gemini, DeepSeek, Groq, or a custom OpenAI-compatible endpoint. The key is checked against the provider, then its model list is fetched so you can pick the models to show in chat. With OpenRouter you can filter for free models and start without adding credit (free models are rate limited by OpenRouter).
- **Use a subscription**: Claude Code (Claude Pro / Max), OpenAI Codex (ChatGPT Plus / Pro) or Antigravity. You sign in with the official CLI inside the workspace sandbox, and the tokens stay there.

Members who are not admins see a message asking an admin to connect a provider. Keys and models can be changed later under **Settings → Provider Keys**.

## Bring your own key (BYOK)

Provider keys:

- belong to one workspace and are used only for its requests,
- are encrypted at rest (see `WORKSPACE_KEYS_ENCRYPTION_KEY` in [Configuration](../02-self-hosting/01-configuration.md)),
- also pay for the small side calls a chat makes: conversation titles, reasoning summaries, memory extraction and project suggestions.

## Model for titles and memory

Side calls run on the workspace's **auxiliary model**, so a short title does not cost as much as a reply from your biggest model. On the Hello page it is set to the cheapest paid model you pick (when the provider publishes prices, as OpenRouter does). Change it under **Settings → Provider Keys → Models**; "Same as the chat model" uses whatever model the chat runs on.

A workspace that only uses a subscription (BYOS) has no API key for side calls: titles then use the first line of the message, and reasoning summaries, memory extraction and AI project suggestions are skipped. Add any API key and pick it as the auxiliary model to turn them on.

## Custom and local models

A workspace can add a custom model that points at any OpenAI-compatible base URL, for example a local Ollama or vLLM server. Use the **Test** button to check the connection before saving.

> [!NOTE]
> The backend makes the request, not your browser. A model at `http://localhost:11434` must be reachable from the backend container; with Docker Compose use `http://host.docker.internal:11434` or the host's IP instead.

## Memory embeddings

Agent memory works with full-text search out of the box. For semantic search, set `MEMORY_EMBEDDING_MODEL` (for example `openrouter:openai/text-embedding-3-small`). Keep it the same once set: embeddings from different models cannot be compared.
