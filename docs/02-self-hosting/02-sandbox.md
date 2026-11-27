---
title: Sandboxes
description: How workspace containers are created, limited and stopped.
---

Every workspace runs its code in its own Docker container, the *default runtime*. The agent's file and command tools, the terminal and port previews all act on that container unless you launch more [named runtimes](#several-runtimes-per-workspace).

## The sandbox image

`Dockerfile.sandbox` at the repository root builds the default image:

```bash
docker build -f Dockerfile.sandbox -t neuronrunner-sandbox:latest .
```

To use your own image (for example with extra language runtimes), build it and point `DOCKER_SANDBOX_IMAGE` to it. If the preferred image is missing, Neuron Runner uses `DOCKER_SANDBOX_FALLBACK_IMAGE` (`python:3.11-slim`).

> [!TIP]
> Start your custom image `FROM neuronrunner-sandbox:latest` so the tools the agent expects stay available.

## Files and persistence

Workspace files are stored on the host under `LOCAL_WORKSPACE_ROOT` and mounted into the container at `/workspace`. With Docker Compose this is the `./workspaces` folder in the repository. Stopping or recreating a container does not delete them.

## Limits and isolation

- CPU, memory and process limits (`--pids-limit 256`).
- `--security-opt no-new-privileges`.
- Workspace secrets (set in the UI, `.env` bulk import supported) are injected as environment variables.
- `DOCKER_SANDBOX_NETWORK` attaches sandboxes to a specific Docker network, useful for restricting what they can reach.

## Several runtimes per workspace

With the local Docker provider (`SANDBOX_PROVIDER=docker`) a workspace can run more than one sandbox at the same time, for example one for an API server and one for a worker or a second branch.

- The **runtime picker** at the left of the workspace toolbar lists the workspace's runtimes and shows how many are running.
- Type a name and choose **Launch** to start a new runtime. Names use lowercase letters, digits and dashes, up to 24 characters; `default` is the workspace's own runtime.
- Click a runtime to select it. A stopped runtime starts when you select it.
- The square button stops a runtime; the trash button deletes a named runtime's container. The default runtime can be stopped but not deleted.

Each named runtime is its own container, `nr-sandbox-workspace-<workspace id>-rt-<name>`, with the same image, limits, secrets and network as the default one. All runtimes mount the same workspace folder at `/workspace`, so files are shared; processes, installed system packages and anything outside `/workspace` are not.

The selected runtime is used by:

- the terminal (open terminals reconnect when you switch);
- chat: a conversation runs its tools and CLI agents in the runtime that was selected when you sent the message;
- file, Git and port-preview requests. A port preview belongs to the runtime that serves it.

The selection is stored per browser and per workspace; other members of the workspace pick their own.

`DOCKER_SANDBOX_MAX_CONCURRENT` (default `3`) caps how many runtimes of a workspace run at once. Launching one more fails with a message until you stop another; `0` removes the limit. The default runtime can always start, so the workspace never locks itself out. Named runtimes are stopped after the same idle timeout as the default one.

The same actions are available through the API, for scripts:

| Method and path | Action |
| --- | --- |
| `GET /sandbox/workspaces/<id>/runtimes/` | List runtimes with their status, the limit and the running count. |
| `POST /sandbox/workspaces/<id>/runtimes/` with `{"name": "api"}` | Start (or resume) a runtime. Answers `409` at the limit. |
| `POST /sandbox/workspaces/<id>/runtimes/<name>/stop/` | Stop a runtime. Files are kept. |
| `DELETE /sandbox/workspaces/<id>/runtimes/<name>/` | Delete a named runtime's container. |

Send the `X-Sandbox-Runtime: <name>` header on other sandbox requests to run them in that runtime.

> [!NOTE]
> Named runtimes are a self-hosted feature. With another `SANDBOX_PROVIDER` these endpoints answer `404` and the provider's own runtime handling applies.

## Idle shutdown

A sandbox with no activity is stopped after `SANDBOX_IDLE_TIMEOUT_DEFAULT` seconds (30 minutes by default). This applies to every runtime of the workspace. A runtime starts again the next time it is needed; files are kept.

## Port previews

When a process inside the sandbox listens on an HTTP port, Neuron Runner detects it and serves it through the preview proxy (`run_preview_proxy`, port 8090). Preview URLs carry short-lived tokens stored in Redis.

> [!WARNING]
> Serve the preview proxy from a different origin than the app (another subdomain or port). Code running in the sandbox is untrusted; a separate origin keeps it away from Neuron Runner's cookies and storage.

## Docker socket access

The backend talks to Docker through `/var/run/docker.sock`, which Compose mounts into the backend container. Anyone who controls the backend can control the Docker host, so run Neuron Runner on a host dedicated to it, keep the host patched, and do not expose the Docker API on the network.
