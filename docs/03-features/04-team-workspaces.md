---
title: Team Workspaces
description: Share a sandbox, secrets and provider keys with your team.
---

A workspace is the unit of sharing in NeuronRunner. Its members share the sandbox container, files, secrets and provider keys.

## Roles

| Role | Can do |
| --- | --- |
| `owner` | Everything, including deleting the workspace and changing owners. |
| `admin` | Invite and remove members, manage provider keys, custom models and secrets. |
| `member` | Use the workspace: chat, files, terminal, Git and previews. |

## Inviting people

Admins invite teammates by email. Invitations need a working email backend (see [Configuration](../02-self-hosting/01-configuration.md#authentication-and-email)); with the default console backend, emails are printed in the backend logs instead of being sent.

## Secrets

Workspace secrets are encrypted environment variables that are injected into the sandbox. Add them one by one, or paste a whole `.env` file to import them in bulk. Values are not shown again after saving.

## Self-hosted limits

The self-hosted edition has no plan limits: unlimited members and sandboxes per workspace. The only limits are your server's resources.
