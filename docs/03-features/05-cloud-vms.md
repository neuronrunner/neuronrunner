---
title: Cloud VMs
description: How cloud VMs start and stop, what is kept between sessions and what is not.
---

> [!NOTE]
> This page describes the hosted Neuron Runner Cloud. Self-hosted installs use Docker sandboxes with a persistent volume instead, see [Sandboxes](../02-self-hosting/02-sandbox.md).

On Neuron Runner Cloud every workspace can run in its own isolated Linux machine with a terminal and a desktop. The machine starts when you use it and closes on its own when you stop.

## Stopping and starting

A VM closes about 30 seconds after you stop using it, meaning no terminal or desktop tab is open and no agent is running. There is no stop button and no setting for it. The next time you open the terminal or desktop or run an agent, the VM starts again by itself, which usually takes a few seconds. Compute is only billed while the VM is running.

A VM also stops on its own after the maximum run time of 24 hours. Your files are kept and it starts again when you use it.

## What is kept

Each VM has its own folder of the workspace volume:

- **`/workspace`**, where your projects live. It is kept for as long as the VM exists. Deleting the VM or the workspace deletes it.
- **Agent and tool settings in the home directory:** the sign-in files and settings of Claude Code, Codex and Gemini (`~/.claude`, `~/.codex`, `~/.gemini`), `~/.claude.json`, global npm packages (`~/.npm-global`), SSH keys (`~/.ssh`), `~/.gitconfig` and the shell history.
- **Agent sign-ins** are also stored encrypted in Neuron Runner's database and written back into every new VM, so your agents stay signed in. Disconnecting an agent or deleting the workspace removes that stored copy.

## Storage limit

Each VM's folder has a storage limit that depends on your plan (by default 5 GB on Free, 20 GB on Plus, 50 GB on Pro and 100 GB on Team). The machine menu shows how much you use.

- At 80% you see a warning.
- If the folder goes over the limit, the VM **closes automatically** and cannot be started again until you are back under it. A message tells you so.
- **Nothing is deleted for you.** Open the file manager and delete files yourself. It works while the VM is closed, without starting it, and also lets you download files first. Other changes (creating, saving and renaming files) are paused until you are under the limit. As soon as the space is freed the VM starts again when you use it.

The limit counts everything in the VM's folder, including the saved home folders such as `~/.npm-global`.

## Cold storage

A VM that stays closed for **7 days** has its files packed into a single compressed archive in separate, cheaper storage, and removed from the fast workspace volume. The machine menu shows that it is archived.

- Nothing is lost: the archive is uploaded and verified before anything is removed.
- The next time you use the VM, your files are **restored first**, then the VM starts. Expect a little extra time: roughly 5 seconds for a 250 MB workspace and about 20 seconds per GB.
- Once restored, the archive is deleted and your files live on the fast volume again, so the week starts over.
- Deleting the VM or the workspace deletes its archive too.

## What is not kept

Everything else on the machine starts fresh every time:

- Software you installed outside the folders above (for example with `apt` or `pip install --user`). Keep dependencies in your project (a virtual environment or `node_modules` inside `/workspace`).
- Desktop settings, browser profiles and caches.
- Running processes, open terminals and in-memory state. They end when the VM closes.
- Workspace secrets are stored encrypted by Neuron Runner and injected again each time the VM starts.

> [!WARNING]
> Push your work to Git regularly. Files are only as safe as the VM that holds them: deleting the VM deletes its `/workspace`.

## Limits of the cloud VM

- **No Docker.** VMs run in a sandboxed environment that does not support running containers.
- **Interruptions.** To keep costs low the machine can occasionally be restarted by the cloud provider. Your files are not affected, but open terminals and running processes end, just as when the VM closes.
- **Network access** from the VM is not restricted.
