---
title: Introduction
description: What NeuronRunner is and what you can do with it.
---

NeuronRunner is an open-source, self-hosted AI coding workspace. Each team workspace gets its own isolated Docker sandbox, and a multi-model chat agent works inside it: it reads and edits files, runs commands, starts dev servers and opens pull requests while you watch and steer.

## What you get

- **Isolated Docker sandboxes**: one container per workspace with a persistent `/workspace` volume and CPU, memory and process limits.
- **Multi-model chat with tool calling**: OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, DeepSeek, Ollama or any OpenAI-compatible endpoint.
- **Bring your own keys**: provider keys are stored encrypted per workspace, or set once on the server.
- **Browser terminal**: a full PTY shell inside the workspace container.
- **Live port previews**: HTTP servers started in the sandbox are served through an isolated-origin proxy.
- **Git & GitHub**: branches, diffs, commits, cloning and pull request review from the UI.
- **MCP connectors**: connect remote Model Context Protocol servers and expose their tools to the agent.
- **Agent memory and notes**: stored per user and per workspace, with optional `pgvector` semantic search.

## Where to go next

- [Quickstart](./02-quickstart.md): run the whole stack with Docker Compose.
- [Architecture](./03-architecture.md): how the pieces fit together.
- [Configuration](../02-self-hosting/01-configuration.md): every environment variable that matters.

> [!NOTE]
> NeuronRunner is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). If you run a modified version as a network service, you must make your changes available to its users.
