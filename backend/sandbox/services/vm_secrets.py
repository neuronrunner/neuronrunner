"""Encrypted workspace environment secret storage and container synchronization."""
from __future__ import annotations

import base64
from contextlib import suppress
import json
import logging
import re
import subprocess

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from rest_framework.exceptions import ValidationError

from sandbox.models import WorkspaceVMSecret

logger = logging.getLogger(__name__)

SECRETS_FILE_PATH = "/var/lib/neuronrunner/secrets.json"
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
MAX_SECRET_VALUE_LENGTH = 32768

RESERVED_ENV_KEYS = frozenset({
    "PATH",
    "HOME",
    "TERM",
    "PS1",
    "DISPLAY",
    "WORKSPACE_ROOT",
    "USER",
    "LOGNAME",
    "SHELL",
    "PWD",
    "OLDPWD",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "PYTHONPATH",
    "PYTHONUNBUFFERED",
})


def cipher() -> Fernet:
    """Return the Fernet cipher used for workspace secrets."""
    configured = getattr(settings, "WORKSPACE_KEYS_ENCRYPTION_KEY", "")
    if configured:
        return Fernet(configured.encode())
    derived = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"neuronrunner-workspace-secrets",
        info=b"workspace-secrets-v1",
    ).derive(settings.SECRET_KEY.encode())
    return Fernet(base64.urlsafe_b64encode(derived))


def validate_secret_key(raw_key: str) -> str:
    """Validate and normalize an environment variable secret name."""
    key = (raw_key or "").strip()
    if not key or not ENV_KEY_RE.fullmatch(key):
        raise ValidationError({
            "key": "Secret name must start with a letter or underscore and contain only letters, numbers, and underscores (max 128 chars)."
        })
    if key.upper() in RESERVED_ENV_KEYS:
        raise ValidationError({
            "key": f"'{key}' is a reserved system environment variable and cannot be overridden."
        })
    return key


def validate_secret_value(raw_value: str) -> str:
    """Validate a secret value before encryption."""
    if not isinstance(raw_value, str) or raw_value == "":
        raise ValidationError({"value": "Secret value is required."})
    if "\x00" in raw_value:
        raise ValidationError({"value": "Secret value cannot contain null bytes."})
    if len(raw_value) > MAX_SECRET_VALUE_LENGTH:
        raise ValidationError({"value": f"Secret value exceeds maximum length of {MAX_SECRET_VALUE_LENGTH} characters."})
    return raw_value


def encrypt_secret(value: str) -> tuple[str, str]:
    """Encrypt a secret value and return (encrypted_token, safe_last4)."""
    validated = validate_secret_value(value)
    encrypted = cipher().encrypt(validated.encode("utf-8")).decode("ascii")
    last4 = validated[-4:] if len(validated) >= 8 else ""
    return encrypted, last4


def decrypt_secret(encrypted_value: str) -> str:
    """Decrypt a stored secret value."""
    if not encrypted_value:
        return ""
    try:
        return cipher().decrypt(encrypted_value.encode("ascii")).decode("utf-8")
    except Exception:
        raise ValueError("Workspace secret could not be decrypted.") from None


def mask_secret(last4: str) -> str:
    """Return a masked display string for a stored secret."""
    if last4:
        return f"••••{last4}"
    return "••••••••"


def resolve_workspace_secrets(workspace) -> dict[str, str]:
    """Resolve effective encrypted secrets for a workspace."""
    if not workspace:
        return {}
    resolved: dict[str, str] = {}
    for item in WorkspaceVMSecret.objects.filter(workspace=workspace).order_by("key"):
        if item.key in RESERVED_ENV_KEYS:
            continue
        with suppress(ValueError):
            resolved[item.key] = decrypt_secret(item.encrypted_value)
    return resolved


resolve_vm_secrets = resolve_workspace_secrets


def sync_secrets_to_container(workspace, target_id=None) -> int:
    """Best-effort sync of secrets.json into active workspace runtimes."""
    if not workspace:
        return 0
    from core.extensions import registry as ext_registry

    if ext_registry.runtime.sync_secrets_to_runtimes is not None:
        synced = ext_registry.runtime.sync_secrets_to_runtimes(workspace, target_id=target_id)
        if synced is not None:
            return synced
    container_name = f"nr-sandbox-workspace-{workspace.pk}"
    try:
        inspect = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if inspect.returncode != 0 or inspect.stdout.strip() != "true":
            return 0
        payload = json.dumps(resolve_workspace_secrets(workspace))
        code = (
            "import sys\n"
            "from pathlib import Path\n"
            "target = Path(sys.argv[1])\n"
            "target.parent.mkdir(parents=True, exist_ok=True)\n"
            "tmp = target.with_suffix('.tmp')\n"
            "tmp.write_text(sys.argv[2], encoding='utf-8')\n"
            "tmp.chmod(0o600)\n"
            "tmp.replace(target)\n"
        )
        res = subprocess.run(
            ["docker", "exec", container_name, "python3", "-c", code, SECRETS_FILE_PATH, payload],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return 1 if res.returncode == 0 else 0
    except Exception as exc:
        logger.debug("Could not sync secrets to container %s: %s", container_name, exc)
        return 0


def parse_dotenv(content: str) -> list[tuple[str, str]]:
    """Parse .env formatted text into a list of (key, value) pairs."""
    if not isinstance(content, str) or not content.strip():
        raise ValidationError({"content": "No environment variables found."})
    entries: list[tuple[str, str]] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        raw_key, raw_val = line.split("=", 1)
        key = validate_secret_key(raw_key)
        val = raw_val.strip()
        if len(val) >= 2 and ((val[0] == '"' and val[-1] == '"') or (val[0] == "'" and val[-1] == "'")):
            val = val[1:-1]
        validate_secret_value(val)
        entries.append((key, val))
    if not entries:
        raise ValidationError({"content": "No valid KEY=VALUE pairs found."})
    return entries
