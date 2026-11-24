"""Model discovery for BYOS CLI providers without backend HTTP requests or OAuth token handling."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Any

from model.reasoning import normalize_tier_name

logger = logging.getLogger(__name__)
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_AGY_MODEL_LINE_RE = re.compile(r"^([a-z0-9][a-z0-9._-]+)(?:\t|\s{2,})(.+)$")
_AGY_TIER_SUFFIX_RE = re.compile(r"\((minimal|low|medium|high|xhigh|max)\)$", re.IGNORECASE)

_VM_PATH_PREFIX = 'PATH="/root/.gemini/bin:$HOME/.gemini/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/root/.npm-global/bin:$PATH"'

_CODEX_CLI_FALLBACK_MODELS: list[dict[str, Any]] = [
    {
        "slug_suffix": "byos-gpt-5-4-codex",
        "display_name": "GPT-5.4",
        "external_model_id": "gpt-5.4",
        "supports_vision": True,
        "supports_tools": True,
        "is_reasoning": True,
        "supported_efforts": ["low", "medium", "high", "xhigh"],
        "default_effort": "medium",
        "context_length": 272000,
        "max_tokens": 16384,
    },
    {
        "slug_suffix": "byos-gpt-5-4-mini",
        "display_name": "GPT-5.4 Mini",
        "external_model_id": "gpt-5.4-mini",
        "supports_vision": True,
        "supports_tools": True,
        "is_reasoning": True,
        "supported_efforts": ["low", "medium", "high"],
        "default_effort": "medium",
        "context_length": 272000,
        "max_tokens": 16384,
    },
    {
        "slug_suffix": "byos-codex-mini",
        "display_name": "Codex Mini",
        "external_model_id": "codex-mini-latest",
        "supports_vision": False,
        "supports_tools": True,
        "is_reasoning": True,
        "supported_efforts": ["low", "medium", "high"],
        "default_effort": "medium",
        "context_length": 200000,
        "max_tokens": 16384,
    },
]


def _slugify_model_id(model_id: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (model_id or "").lower()).strip("-")


def _find_cli_binary(binary: str) -> str | None:
    found = shutil.which(binary)
    if found:
        return found
    for candidate in (
        Path.home() / ".local" / "bin" / binary,
        Path("/usr/local/bin") / binary,
        Path("/usr/bin") / binary,
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def _find_agy_binary() -> str | None:
    return _find_cli_binary("agy")


def _read_vm_command_output(runtime, shell_command: str, timeout: int = 20) -> tuple[str, int | None]:
    proc = runtime.exec("sh", "-lc", f"{_VM_PATH_PREFIX} {shell_command}", timeout=timeout)
    stdout = proc.stdout.read() if getattr(proc, "stdout", None) else ""
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", errors="replace")
    exit_code = proc.wait(timeout)
    return str(stdout or ""), exit_code


def _parse_agy_models_output(raw_output: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    # Replace carriage returns used by spinner animations with newlines before scanning.
    cleaned = _ANSI_RE.sub("", (raw_output or "").replace("\r", "\n"))
    for line in cleaned.splitlines():
        stripped = line.strip()
        if not stripped or "Fetching available models" in stripped:
            continue
        match = _AGY_MODEL_LINE_RE.match(stripped)
        if not match:
            continue
        model_id = match.group(1).strip()
        display_name = match.group(2).strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        has_tier_variant = bool(_AGY_TIER_SUFFIX_RE.search(display_name))
        out.append(
            {
                "slug_suffix": f"byos-antigravity-{_slugify_model_id(model_id)}",
                "display_name": display_name,
                "external_model_id": model_id,
                "supports_vision": True,
                "supports_tools": True,
                "is_reasoning": has_tier_variant,
                "context_length": 1000000 if "gemini" in model_id else 200000,
                "max_tokens": 16384,
            }
        )
    return out


def _fetch_antigravity_cli_models(*, runtime=None) -> tuple[list[dict[str, Any]], str | None]:
    """Query `agy models` inside the user's VM (or local CLI if installed) without backend HTTP calls."""
    if runtime is not None:
        try:
            stdout, exit_code = _read_vm_command_output(runtime, "agy models", timeout=20)
            parsed = _parse_agy_models_output(stdout)
            if parsed:
                return parsed, None
            return [], f"VM agy models returned 0 models (exit={exit_code})"
        except Exception as exc:
            logger.warning("VM agy models invocation failed: %s", exc)
            return [], f"VM agy models failed: {exc}"

    agy_bin = _find_agy_binary()
    if not agy_bin:
        return [], None
    try:
        res = subprocess.run(
            [agy_bin, "models"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        parsed = _parse_agy_models_output(res.stdout or "")
        if parsed:
            return parsed, None
        err = (res.stderr or res.stdout or "").strip()
        return [], f"agy models returned 0 models{f': {err[:160]}' if err else ''}"
    except Exception as exc:
        logger.warning("agy models invocation failed: %s", exc)
        return [], f"agy models failed: {exc}"


def _parse_codex_debug_models_output(raw_output: str) -> list[dict[str, Any]]:
    cleaned = _ANSI_RE.sub("", (raw_output or "")).strip()
    if not cleaned:
        return []
    if not cleaned.startswith("{"):
        brace_idx = cleaned.find("{")
        if brace_idx == -1:
            return []
        cleaned = cleaned[brace_idx:]
    try:
        payload = json.loads(cleaned)
    except ValueError:
        return []

    raw_items = payload.get("models")
    if not isinstance(raw_items, list):
        return []

    has_explicit_list = any(
        isinstance(item, dict) and str(item.get("visibility") or "").lower() == "list"
        for item in raw_items
    )

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        visibility = str(item.get("visibility") or "").lower()
        if has_explicit_list:
            if visibility != "list":
                continue
        elif visibility == "hide":
            continue

        mid = str(item.get("slug") or item.get("id") or "").strip()
        if not mid or mid in seen:
            continue
        seen.add(mid)

        dname = str(item.get("display_name") or item.get("title") or mid).strip()
        modalities = item.get("input_modalities")
        supports_vision = (
            "image" in [str(m).lower() for m in modalities]
            if isinstance(modalities, list) and modalities
            else True
        )

        efforts: list[str] = []
        for entry in item.get("supported_reasoning_levels") or []:
            raw_effort = entry.get("effort") if isinstance(entry, dict) else entry
            norm_effort = normalize_tier_name(raw_effort)
            if norm_effort and norm_effort != "none" and norm_effort not in efforts:
                efforts.append(norm_effort)

        is_reasoning = bool(efforts)
        default_effort = normalize_tier_name(item.get("default_reasoning_level")) if is_reasoning else "none"
        if is_reasoning:
            if not default_effort or default_effort not in efforts:
                default_effort = "medium" if "medium" in efforts else efforts[0]

        out.append(
            {
                "slug_suffix": f"byos-{_slugify_model_id(mid)}",
                "display_name": dname,
                "external_model_id": mid,
                "supports_vision": supports_vision,
                "supports_tools": True,
                "is_reasoning": is_reasoning,
                "supported_efforts": efforts,
                "default_effort": default_effort or "none",
                "context_length": int(item.get("context_window") or 200000),
                "max_tokens": 16384,
            }
        )
    return out


def _fetch_codex_cli_models(secret: str = "", *, runtime=None) -> tuple[list[dict[str, Any]], str | None]:
    """Query `codex debug models` inside the user's VM (or local CLI) without backend HTTP calls."""
    if runtime is not None:
        try:
            stdout, exit_code = _read_vm_command_output(runtime, "codex debug models", timeout=25)
            parsed = _parse_codex_debug_models_output(stdout)
            if parsed:
                return parsed, None
            return [], f"VM codex debug models returned 0 models (exit={exit_code})"
        except Exception as exc:
            logger.warning("VM codex debug models invocation failed: %s", exc)
            return [], f"VM codex debug models failed: {exc}"

    codex_bin = _find_cli_binary("codex")
    if not codex_bin:
        return [], None
    raw_secret = (secret or "").strip()
    try:
        with tempfile.TemporaryDirectory(prefix="nr-codex-models-") as tmp_dir:
            env = os.environ.copy()
            if raw_secret:
                env["CODEX_HOME"] = tmp_dir
                if raw_secret.startswith("{"):
                    auth_path = Path(tmp_dir) / "auth.json"
                    auth_path.write_text(raw_secret, encoding="utf-8")
                    os.chmod(auth_path, 0o600)
                    env.pop("OPENAI_API_KEY", None)
                else:
                    env["OPENAI_API_KEY"] = raw_secret

            res = subprocess.run(
                [codex_bin, "debug", "models"],
                capture_output=True,
                text=True,
                env=env,
                timeout=20,
            )
            parsed = _parse_codex_debug_models_output(res.stdout or "")
            if parsed:
                return parsed, None
            err = (res.stderr or res.stdout or "").strip()
            return [], f"codex debug models returned 0 models{f': {err[:160]}' if err else ''}"
    except Exception as exc:
        logger.warning("codex debug models invocation failed: %s", exc)
        return [], f"codex debug models failed: {exc}"


_CLAUDE_INIT_REQUEST = '{"type":"control_request","request_id":"nr-models","request":{"subtype":"initialize"}}'


def _find_claude_models_payload(obj: Any) -> list[Any] | None:
    """Locate the `models` list inside a control_response (path differs across CLI versions)."""
    if isinstance(obj, dict):
        models = obj.get("models")
        if isinstance(models, list):
            return models
        for value in obj.values():
            found = _find_claude_models_payload(value)
            if found is not None:
                return found
    return None


def _parse_claude_initialize_output(raw_output: str) -> list[dict[str, Any]]:
    """Parse the model roster the Claude Code CLI itself reports (same list as its /model picker).

    The CLI lists moving aliases (`opus`, `sonnet`, `haiku`, ...) plus pinned legacy ids. Only the
    aliases are exposed: `--model <alias>` always resolves to the CLI's current model, so the picker
    never goes stale. `default` duplicates an alias and is skipped.
    """
    items: list[Any] = []
    for line in _ANSI_RE.sub("", raw_output or "").splitlines():
        line = line.strip()
        if not line.startswith("{") or "control_response" not in line:
            continue
        try:
            found = _find_claude_models_payload(json.loads(line))
        except ValueError:
            continue
        if found:
            items = found
            break

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        value = str(item.get("value") or "").strip()
        lowered = value.lower()
        if (
            not value
            or lowered == "default"
            or lowered.startswith("claude-")
            or "plan" in lowered
            or value in seen
        ):
            continue
        seen.add(value)
        resolved = str(item.get("resolvedModel") or value).strip()
        display = str(item.get("displayName") or value).strip()
        efforts: list[str] = []
        if item.get("supportsEffort"):
            for raw_effort in item.get("supportedEffortLevels") or []:
                effort = normalize_tier_name(raw_effort)
                if effort and effort != "none" and effort not in efforts:
                    efforts.append(effort)
        default_effort = ("medium" if "medium" in efforts else efforts[0]) if efforts else "none"
        out.append(
            {
                "slug_suffix": f"byos-claude-{_slugify_model_id(value)}",
                "display_name": f"Claude {display}",
                "external_model_id": value,
                "resolved_model_id": resolved,
                "supports_vision": True,
                "supports_tools": True,
                "is_reasoning": bool(efforts),
                "supported_efforts": efforts,
                "default_effort": default_effort,
                "context_length": 1000000 if "[1m]" in lowered else 200000,
                "max_tokens": 16384,
            }
        )
    return out


def _fetch_claude_cli_models(*, runtime=None) -> tuple[list[dict[str, Any]], str | None]:
    """Ask the Claude Code CLI in the VM for its own model list (no OAuth token is read or reused)."""
    if runtime is None:
        return [], None
    # Leading ";" turns the PATH=... prefix into a plain assignment (a subshell can't follow `VAR=x`).
    cmd = (
        f"; (printf '%s\\n' '{_CLAUDE_INIT_REQUEST}'; sleep 8) | "
        "claude -p --input-format stream-json --output-format stream-json --verbose 2>/dev/null"
    )
    try:
        stdout, exit_code = _read_vm_command_output(runtime, cmd, timeout=40)
        parsed = _parse_claude_initialize_output(stdout)
        if parsed:
            return parsed, None
        return [], f"VM claude initialize returned 0 models (exit={exit_code})"
    except Exception as exc:
        logger.warning("VM claude initialize failed: %s", exc)
        return [], f"VM claude initialize failed: {exc}"


def fetch_live_byos_models_with_status(
    provider: str,
    secret: str = "",
    *,
    runtime=None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Discover available BYOS models from the VM CLI or built-in CLI roster (zero backend HTTP requests)."""
    if provider == "anthropic_sub":
        cli_models, cli_err = _fetch_claude_cli_models(runtime=runtime)
        if cli_models:
            return cli_models, None
        return [], cli_err or "Start a workspace VM with Claude Code installed to sync live models."

    if provider == "openai_sub":
        cli_models, cli_err = _fetch_codex_cli_models(secret, runtime=runtime)
        if cli_models:
            return cli_models, None
        return [dict(item) for item in _CODEX_CLI_FALLBACK_MODELS], cli_err

    if provider == "antigravity_sub":
        cli_models, cli_err = _fetch_antigravity_cli_models(runtime=runtime)
        if cli_models:
            return cli_models, None
        return [], cli_err or "Start a workspace VM with the Antigravity CLI to sync live models."

    return [], f"Unsupported BYOS provider: {provider}"


def fetch_live_byos_models(provider: str, secret: str = "", *, runtime=None) -> list[dict[str, Any]]:
    """Fetch available models for a BYOS provider without making backend HTTP requests."""
    models, _warning = fetch_live_byos_models_with_status(provider, secret, runtime=runtime)
    return models
