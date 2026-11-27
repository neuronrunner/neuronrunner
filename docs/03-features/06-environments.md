---
title: Environments
description: Configure unlimited repo-backed environments with setup scripts, scoped encrypted secrets, and automatic dependency caching.
---

**Environments** connect your Git repositories to repeatable setups — complete with setup and maintenance scripts, environment-scoped encrypted secrets, and custom agent instructions.

## Creating an environment

You can create **unlimited environments** per workspace from the sidebar (`Environments → +`) or from the chat bar selector:

1. **GitHub Repo (recommended):** Pick a connected GitHub repository (or paste a URL / `owner/repo`) and choose the default branch. The environment is saved immediately — the repository is cloned when you start your first task or click **Run setup**.
2. **New Folder / Existing Folder:** Create a blank Git-initialized folder inside `/workspace` or attach an existing repository folder.

Optionally expand **Setup scripts, secrets & instructions** to configure:

- **Stack presets:** One-click defaults for `Node / npm`, `pnpm`, `Python / uv`, `Go`, and `Rust`.
- **Setup script:** Runs automatically on a fresh start or whenever your lockfiles change (e.g. `npm ci`, `uv sync`).
- **Maintenance script:** Runs automatically when a conversation opens an isolated Git branch worktree.
- **Working subdirectory:** Optional monorepo subpath (e.g. `apps/web`).
- **Environment secrets (`.env`):** Encrypted at rest and injected into agent runs for this environment only. Keys with the same name override workspace-level secrets.
- **Agent instructions:** Repo-specific conventions, test commands, or notes included in agent context.

## Saving work & dependency caching

- **In-progress work:** Uncommitted changes, untracked source files, and unpushed commits are preserved automatically between sessions.
- **Dependency caching:** Installed dependencies (such as `node_modules` or Python virtual environments) are cached per lockfile so future sessions start faster. Unused caches expire automatically after 7 days, or you can clear an environment's cache anytime from **Environment Settings → Scripts & Cache → Clear cache**.

> [!TIP]
> Keep Git as your source of truth and push branches regularly. Avoid keeping very large datasets, media files, or model weights inside your working folder — store them in external storage (such as S3, R2, or Hugging Face) and list their local paths in `.gitignore`.

## Environment settings

Click the settings icon next to any environment to manage:

- **General:** Name, description, repository URL, default branch, working subdirectory, and agent instructions.
- **Scripts & Cache:** Setup/maintenance scripts, current status (`Idle` / `Running` / `Ready` / `Failed`), last setup log, **Run setup**, and **Clear cache**.
- **Secrets:** Environment-scoped encrypted secrets (single key or `.env` bulk paste) plus a read-only view of inherited workspace secrets showing which keys are overridden.
