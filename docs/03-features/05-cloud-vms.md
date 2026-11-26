---
title: Cloud VMs
description: How persistent cloud VMs are stopped, restored and how long their data is kept.
---

> [!NOTE]
> This page describes the hosted Neuron Runner Cloud. Self-hosted installs use Docker sandboxes with a persistent volume instead, see [Sandboxes](../02-self-hosting/02-sandbox.md).

On Neuron Runner Cloud every workspace can run in its own isolated virtual machine with your files, installed tools and terminal sessions.

## Stopping and starting

When a VM stops, its whole disk is saved as a snapshot and the machine is shut down. Starting it again creates a new machine from that snapshot, which usually takes a couple of seconds. Compute is only billed while the VM is running.

A VM also stops on its own when it reaches the maximum run time of 24 hours. Your data is saved when that happens, and you can start it again right away.

## How long data is kept

A stopped VM's snapshot is kept for **14 days**. After that it is **permanently deleted** and cannot be recovered. Starting the VM again before then restores everything, and the next time you stop it a fresh snapshot is saved and the 14 days start over.

What is kept is the whole disk of the VM: your project files, installed packages, shell history and the sign-in files of agents you connected inside the VM (Claude Code, Codex, Antigravity). If the snapshot expires, those sign-ins are removed too and you need to connect your agent again.

> [!WARNING]
> Push your work to Git regularly. Uncommitted changes in a VM that stays stopped for more than 14 days are lost.

## What is not kept

- Running processes, open terminals and in-memory state. They end when the VM stops.
- Workspace secrets are stored encrypted by Neuron Runner and injected again each time the VM starts. A copy also sits on the VM's disk while it runs, so it is part of the snapshot.
