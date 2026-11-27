---
title: MCP Connectors
description: Give the agent tools from Model Context Protocol servers.
---

The [Model Context Protocol](https://modelcontextprotocol.io) lets external servers offer tools to an AI agent. Neuron Runner can connect to MCP servers and expose their tools in chat.

## Adding a server

Open the connectors page, choose **Add connector** and enter the server URL. Neuron Runner supports:

- **OAuth**: you are redirected to the provider to approve access.
- **Bearer token**: paste a token or API key the server expects.
- **No auth**: for public servers.

Once connected, the server's tools appear in chat and the agent can call them.

## Remote-only mode

By default (`REMOTE_ONLY_MCP=true`) users can only add remote HTTP/SSE servers. Local `stdio` servers run commands on the backend host, so only enable them on instances where every user is trusted.

| Variable | Effect |
| --- | --- |
| `REMOTE_ONLY_MCP` | `false` allows local `stdio` servers. |
| `MCP_URL_VALIDATION_ENABLED` | Validates server URLs before connecting. |
| `MCP_ALLOW_PRIVATE_URLS` | Allows servers on private network addresses (e.g. `10.x`, `192.168.x`). |

> [!CAUTION]
> Enabling `MCP_ALLOW_PRIVATE_URLS` lets users make the backend send requests into your internal network. Leave it off on shared instances.

## Built-in browser

The agent also has a built-in browser tool based on Playwright MCP. Turn it off with `BUILTIN_BROWSER_ENABLED=false`.
