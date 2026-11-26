---
title: Environments
description: Configure unlimited repo-backed environments with setup scripts, scoped encrypted secrets, and automatic state & dependency caching.
---

**Environments** connect your Git repositories to repeatable cloud execution setups — complete with setup/maintenance scripts, environment-scoped encrypted secrets, and fast local NVMe execution.

## Creating an environment

You can create **unlimited environments** per workspace from the sidebar (`Environments → +`) or from the chat bar selector:

1. **GitHub Repo (recommended):** Pick a connected GitHub repository (or paste a URL / `owner/repo`) and choose the default branch. The environment is saved instantly without waking a machine — the repository is cloned lazily on your first task or when you click **Run setup**.
2. **New Folder / Existing Folder:** Create a blank Git-initialized folder inside `/workspace` or attach an existing repository folder.

Optionally expand **Setup scripts, secrets & instructions** to configure:

- **Stack presets:** One-click defaults for `Node / npm`, `pnpm`, `Python / uv`, `Go`, and `Rust`.
- **Setup script:** Runs once on a fresh boot or whenever your lockfiles change (e.g. `npm ci`, `uv sync`).
- **Maintenance script:** Runs automatically when a conversation opens an isolated Git branch worktree.
- **Working subdirectory:** Optional monorepo subpath (e.g. `apps/web`).
- **Environment secrets (`.env`):** Encrypted at rest and injected into agent runs for this environment only. Keys with the same name override workspace-level secrets.
- **Agent instructions:** Repo-specific conventions, test commands, or notes included in agent context.

## How state & dependency caching works

Every environment executes directly on the container's **fast local ephemeral NVMe disk** (`/workspace/<slug>`). Behind the scenes, Neuron Runner maintains two lightweight persistence layers:

1. **Compressed state checkpoints (`state/<env>.tar.zst`):**
   - Automatically saves unpushed commits (git bundle), uncommitted working-tree diffs, and untracked source files after agent turns and on container shutdown.
   - Heavy derived directories (`node_modules`, `.venv`, `venv`, `vendor`, `.next`, `dist`, `build`, `target`, `__pycache__`) are excluded automatically even if missing from `.gitignore`.
   - On a fresh container boot, the repo is cloned and your saved state is reapplied automatically so no work is lost.
2. **Hybrid dependency cache (`deps/` & `deps-dir/`):**
   - Keyed by your lockfile hash (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `uv.lock`, `poetry.lock`, `requirements.txt`, `pyproject.toml`, `go.sum`, `Cargo.lock`, with fallback to `package.json`, `go.mod`, `Cargo.toml`).
   - **≤ 300 MB:** Stored as a `zstd`-compressed archive and extracted onto local NVMe in ~1 second.
   - **> 300 MB:** Stored unpacked and symlinked back into the environment for sub-second startup.
   - **7-day TTL:** Dependency caches untouched for 7 days are automatically pruned. You can also clear an environment's cache manually under **Environment Settings → Scripts & Cache → Clear cache**.

## Storage & state guardrails

To keep restarts fast, prevent shutdown timeouts, and avoid runaway storage bills from accidental datasets or model weights, state and dependency persistence enforce the following limits:

| Layer | Limit | Behavior when exceeded |
| --- | --- | --- |
| **Single untracked / non-git file** | **50 MB** | Skipped from `state.tar.zst` (`skipped_large_files`); all source code, git diffs, and unpushed commits are still saved normally. |
| **Total uncommitted state archive** | **1 GB** per environment | State checkpoint pauses (`state_too_large`) so shutdowns never hang. Commit & push your changes or add large files to `.gitignore`. |
| **Derived dependency cache** | **5 GB** per environment | Dependencies stay on local NVMe for the active session and are not copied to the persistent store; untouched caches expire after **7 days**. |

> [!TIP]
> Keep Git as your source of truth and push branches regularly. Store large datasets, media assets, or model weights in external object storage (S3 / R2 / Hugging Face) and list their local paths in `.gitignore`.

## Environment settings

Click the settings icon next to any environment to manage:

- **General:** Name, description, repository URL, default branch, working subdirectory, and agent instructions.
- **Scripts & Cache:** Setup/maintenance scripts, current status (`Idle` / `Running` / `Ready` / `Failed`), last setup log, **Run setup**, and **Clear cache**.
- **Secrets:** Environment-scoped encrypted secrets (single key or `.env` bulk paste) plus a read-only view of inherited workspace secrets showing which keys are overridden.
