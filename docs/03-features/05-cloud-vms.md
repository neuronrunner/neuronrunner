---
title: Cloud VMs
description: How cloud machines start and stop, what is kept between sessions, and what to expect in Neuron Runner Cloud.
---

> [!NOTE]
> This page describes Neuron Runner Cloud. Self-hosted installs run in local Docker sandboxes instead — see [Sandboxes](../02-self-hosting/02-sandbox.md).

On Neuron Runner Cloud, each workspace runs in an isolated Linux machine with a terminal and a desktop. It starts automatically when you use it and stops when you are done.

## Starting and stopping

Your cloud machine stops automatically about 5 minutes after you stop using it (when no terminal or desktop tab is open and no agent is running). The next time you open the terminal, desktop, or Files panel — or send a message — it starts back up in seconds.

Compute is only billed while the machine is running. Stopped machines cost `$0.00`. A single continuous session can run for up to 24 hours before stopping automatically.

## What is kept between sessions

- **Your project changes:** Uncommitted edits, untracked source files, and unpushed commits in your environments are saved automatically between sessions.
- **Tool sign-ins and settings:** Your CLI agent logins and common developer settings (such as Claude Code, Codex, Gemini, SSH keys, Git config, and shell history) stay signed in across restarts.
- **Secrets:** Workspace and environment secrets are stored encrypted and loaded into every new session.

## What starts fresh

- **System packages:** Anything installed globally via `apt` or system package managers resets on a fresh boot. Add project setup commands to your environment's **Setup script** instead.
- **Large files and datasets:** Very large untracked binaries, datasets, or model weights are not preserved between sessions.
- **Running processes and desktop caches:** Open terminals, background processes, browser profiles, and temporary caches end when the machine stops.

> [!WARNING]
> Treat Git (GitHub / GitLab) as your source of truth and push your work regularly. Automatic session saving is meant to protect in-progress code, not replace Git or store large binary assets.

## Cloud VM limits

- **No Docker:** Nested Docker containers are not supported inside cloud VMs.
- **Occasional restarts:** Cloud machines may occasionally restart for maintenance; your saved project state is preserved, while running processes stop as on a normal shutdown.
- **Network access:** Outbound internet access from the VM is unrestricted.
