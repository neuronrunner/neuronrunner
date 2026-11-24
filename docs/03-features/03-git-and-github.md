---
title: Git & GitHub
description: Branches, diffs, commits and pull requests from the workspace.
---

Every sandbox has Git, and the web app has a Git panel on top of it.

## In the Git panel

- Clone a repository into `/workspace`.
- Switch and create branches.
- Inspect staged and unstaged diffs file by file.
- Stage, commit and push.
- Browse and review GitHub pull requests and issues.

The agent can do the same through its tools, so you can ask it to *"create a branch, fix the failing test and open a pull request"*.

## Connecting GitHub

GitHub access uses an OAuth app:

1. Create an OAuth app in GitHub (**Settings → Developer settings → OAuth Apps**).
2. Set the callback URL to your backend's GitHub callback (the value you put in `GITHUB_REDIRECT_URI`).
3. Put the credentials in `backend/.env`:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=https://api.example.com/...
```

The same app is used for "Sign in with GitHub".

> [!TIP]
> For private repositories without OAuth, add a personal access token as a workspace secret (for example `GITHUB_TOKEN`). It is injected into the sandbox as an environment variable.
