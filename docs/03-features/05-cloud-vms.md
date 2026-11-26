---
title: Cloud VMs
description: How cloud VMs start and stop, how ephemeral NVMe and compressed state persistence work, and what is kept between sessions.
---

> [!NOTE]
> This page describes the hosted Neuron Runner Cloud. Self-hosted installs use Docker sandboxes with a persistent volume instead, see [Sandboxes](../02-self-hosting/02-sandbox.md).

On Neuron Runner Cloud every workspace runs in an isolated Linux machine with a terminal and a desktop. The machine starts when you use it and closes on its own when you stop.

## Stopping and starting

A VM closes about 30 seconds after you stop using it, meaning no terminal or desktop tab is open and no agent is running. The next time you open the terminal or desktop or run an agent, the VM restores from a memory snapshot in seconds. Compute is only billed while the VM is running — stopped VMs cost `$0.00`.

A VM also stops on its own after the maximum run time of 24 hours. Before shutdown, active environments are checkpointed automatically so you can pick up right where you left off.

## Local NVMe disk & persistence

`/workspace` runs directly on the container's **fast local ephemeral NVMe disk** so installs, builds, and git operations run at full local speed. Instead of enforcing per-plan disk caps or cold-storage locks, Neuron Runner Cloud persists only what matters in a hidden workspace store (`/var/lib/nr-store`):

- **Environment state checkpoints (`state/<env>.tar.zst`):** Unpushed commits (git bundle), uncommitted diffs, and untracked source files are archived automatically after agent turns and on container shutdown. See [Environments](./06-environments.md) for the exact size guardrails (**50 MB** per untracked file, **1 GB** total state cap).
- **Derived dependency caches (`deps/` & `deps-dir/`):** `node_modules`, `.venv`, `venv`, and `vendor` are cached per lockfile hash (≤ 300 MB as fast `tar.zst` archives extracted to local NVMe; > 300 MB as symlinked directories; capped at **5 GB** per environment) and automatically pruned after **7 days** of inactivity.
- **Agent and tool settings in the home directory:** Sign-in files and settings for Claude Code, Codex, and Gemini (`~/.claude`, `~/.codex`, `~/.gemini`), `~/.claude.json`, global npm packages (`~/.npm-global`), SSH keys (`~/.ssh`), `~/.gitconfig`, and shell history.
- **Agent sign-ins & encrypted secrets:** Stored encrypted in Neuron Runner's database and injected into every new VM and environment run.

## Shared read-only package cache

Public packages from npm, PyPI (`pip` / `uv`), and Go are served through a local read-only cache proxy (`127.0.0.1:4873`). Frequently used public tarballs and wheels are served directly from a shared read-only cache without re-downloading from the public internet.

## What is not kept

Everything else on the machine starts fresh on every new boot:

- System packages installed outside the persisted paths (for example with `apt`). Put project setup commands in your Environment's **Setup script** instead.
- Large temporary binaries, datasets, or model weights exceeding the state guardrails (**> 50 MB** per untracked file or **> 1 GB** total uncommitted state).
- Desktop settings, browser profiles, and temporary caches.
- Running processes, open terminals, and in-memory state. They end when the VM closes.

> [!WARNING]
> Treat Git (GitHub / GitLab) as your source of truth and push your work regularly. State checkpoints protect uncommitted source code between sessions, not large binary assets or datasets.

## Limits of the cloud VM

- **No Docker.** VMs run in a sandboxed environment that does not support running nested containers.
- **Interruptions.** To keep costs low the machine can occasionally be restarted by the cloud provider. Active environments are checkpointed on exit, and open terminals/processes end as on a normal stop.
- **Network access** from the VM is not restricted.
