"""Test helpers: every LLM request needs the workspace's own provider key."""
from sandbox.models import WorkspaceProviderKey
from sandbox.services.provider_keys import cipher


def add_workspace_key(workspace, provider='openrouter', secret='sk-or-workspace-test-key', *, user=None, base_url=''):
    """Store an encrypted provider key for ``workspace`` so its requests run as BYOK."""
    key, _ = WorkspaceProviderKey.objects.update_or_create(
        workspace=workspace,
        provider=provider,
        defaults={
            'encrypted_key': cipher().encrypt(secret.encode()).decode() if secret else '',
            'last4': secret[-4:] if secret else '',
            'base_url': base_url,
            'created_by': user or workspace.owner,
        },
    )
    return key
