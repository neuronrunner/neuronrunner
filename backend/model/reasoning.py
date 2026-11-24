"""Shared reasoning tier metadata, normalization, and provider payload helpers."""
from __future__ import annotations

from typing import Any

REASONING_MODE_NONE = "none"
REASONING_MODE_EFFORT = "effort"
REASONING_MODE_TOGGLE = "toggle"
REASONING_MODE_FIXED = "fixed"

REASONING_MODE_CHOICES = (
    (REASONING_MODE_NONE, "None"),
    (REASONING_MODE_EFFORT, "Effort Tiers"),
    (REASONING_MODE_TOGGLE, "On / Off Toggle"),
    (REASONING_MODE_FIXED, "Always On"),
)

REASONING_EFFORT_NONE = "none"
REASONING_EFFORT_MINIMAL = "minimal"
REASONING_EFFORT_LOW = "low"
REASONING_EFFORT_MEDIUM = "medium"
REASONING_EFFORT_HIGH = "high"
REASONING_EFFORT_XHIGH = "xhigh"
REASONING_EFFORT_MAX = "max"
REASONING_EFFORT_ON = "on"

EFFORT_ORDER = (
    REASONING_EFFORT_NONE,
    REASONING_EFFORT_MINIMAL,
    REASONING_EFFORT_LOW,
    REASONING_EFFORT_MEDIUM,
    REASONING_EFFORT_HIGH,
    REASONING_EFFORT_XHIGH,
    REASONING_EFFORT_MAX,
)

ALL_CANONICAL_TIERS = EFFORT_ORDER + (REASONING_EFFORT_ON,)
CANONICAL_TIER_INDEX = {tier: idx for idx, tier in enumerate(ALL_CANONICAL_TIERS)}

ACTIVE_EFFORT_VALUES = (
    REASONING_EFFORT_MINIMAL,
    REASONING_EFFORT_LOW,
    REASONING_EFFORT_MEDIUM,
    REASONING_EFFORT_HIGH,
    REASONING_EFFORT_XHIGH,
    REASONING_EFFORT_MAX,
)
EFFORT_RANK = {tier: idx for idx, tier in enumerate(ACTIVE_EFFORT_VALUES, start=1)}

LEGACY_DEFAULT_TIERS = [
    REASONING_EFFORT_LOW,
    REASONING_EFFORT_MEDIUM,
    REASONING_EFFORT_HIGH,
]

ALLOWED_REASONING_LEVELS = set(ALL_CANONICAL_TIERS)

REASONING_ALIASES = {
    "off": REASONING_EFFORT_NONE,
    "disabled": REASONING_EFFORT_NONE,
    "enabled": REASONING_EFFORT_ON,
}

REASONING_EFFORT_CHOICES = (
    (REASONING_EFFORT_NONE, "None (Off)"),
    (REASONING_EFFORT_MINIMAL, "Minimal"),
    (REASONING_EFFORT_LOW, "Low"),
    (REASONING_EFFORT_MEDIUM, "Medium"),
    (REASONING_EFFORT_HIGH, "High"),
    (REASONING_EFFORT_XHIGH, "XHigh"),
    (REASONING_EFFORT_MAX, "Max"),
    (REASONING_EFFORT_ON, "On (Enabled)"),
)


def normalize_tier_name(value: Any) -> str | None:
    """Normalize a reasoning tier string to its canonical lowercase token, or None if invalid."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower()
    if not cleaned:
        return None
    cleaned = REASONING_ALIASES.get(cleaned, cleaned)
    return cleaned if cleaned in CANONICAL_TIER_INDEX else None


def sort_canonical_tiers(values: Any) -> list[str]:
    """Normalize, deduplicate, and sort tiers in canonical ascending order."""
    if not isinstance(values, (list, tuple, set)):
        return []
    seen = set()
    for item in values:
        norm = normalize_tier_name(item)
        if norm:
            seen.add(norm)
    return sorted(seen, key=lambda t: CANONICAL_TIER_INDEX[t])


def _get_llm_config_safe(model: Any):
    if model is None:
        return None
    try:
        return getattr(model, "llm_config", None)
    except Exception:
        return None


def _pick_default_effort(tiers: list[str], preferred: str | None = None) -> str:
    if preferred and preferred in tiers:
        return preferred
    for candidate in (
        REASONING_EFFORT_MEDIUM,
        REASONING_EFFORT_HIGH,
        REASONING_EFFORT_LOW,
        REASONING_EFFORT_MAX,
        REASONING_EFFORT_XHIGH,
        REASONING_EFFORT_MINIMAL,
        REASONING_EFFORT_ON,
    ):
        if candidate in tiers:
            return candidate
    return tiers[0] if tiers else REASONING_EFFORT_NONE


def get_model_reasoning_spec(model: Any) -> dict[str, Any]:
    """Return canonical reasoning capabilities for a Model (or duck-typed test model)."""
    is_reasoning = bool(getattr(model, "is_reasoning", False))
    if not is_reasoning:
        return {
            "is_reasoning": False,
            "mode": REASONING_MODE_NONE,
            "tiers": [],
            "default": REASONING_EFFORT_NONE,
            "has_explicit_tiers": False,
        }

    llm_cfg = _get_llm_config_safe(model)

    raw_mode = getattr(model, "reasoning_mode", None) or getattr(llm_cfg, "reasoning_mode", None)
    raw_mode = raw_mode.strip().lower() if isinstance(raw_mode, str) else None

    raw_efforts = (
        getattr(model, "supported_reasoning_efforts", None)
        or getattr(model, "reasoning_tiers", None)
        or getattr(llm_cfg, "supported_reasoning_efforts", None)
    )
    tiers = sort_canonical_tiers(raw_efforts)

    raw_default = getattr(model, "default_reasoning_effort", None) or getattr(
        llm_cfg, "default_reasoning_effort", None
    )
    norm_default = normalize_tier_name(raw_default)

    if raw_mode == REASONING_MODE_FIXED or (tiers == [REASONING_EFFORT_ON] and raw_mode != REASONING_MODE_TOGGLE):
        return {
            "is_reasoning": True,
            "mode": REASONING_MODE_FIXED,
            "tiers": [REASONING_EFFORT_ON],
            "default": REASONING_EFFORT_ON,
            "has_explicit_tiers": True,
        }

    if raw_mode == REASONING_MODE_TOGGLE or (tiers and set(tiers) <= {REASONING_EFFORT_NONE, REASONING_EFFORT_ON}):
        toggle_tiers = [REASONING_EFFORT_NONE, REASONING_EFFORT_ON]
        default_tier = norm_default if norm_default in toggle_tiers else REASONING_EFFORT_ON
        return {
            "is_reasoning": True,
            "mode": REASONING_MODE_TOGGLE,
            "tiers": toggle_tiers,
            "default": default_tier,
            "has_explicit_tiers": True,
        }

    effort_tiers = [t for t in tiers if t in EFFORT_ORDER]
    if effort_tiers:
        # Ensure at least one active tier if somehow only "none" was passed
        if effort_tiers == [REASONING_EFFORT_NONE]:
            effort_tiers = list(LEGACY_DEFAULT_TIERS)
        default_tier = _pick_default_effort(effort_tiers, preferred=norm_default)
        return {
            "is_reasoning": True,
            "mode": REASONING_MODE_EFFORT,
            "tiers": effort_tiers,
            "default": default_tier,
            "has_explicit_tiers": True,
        }

    # Legacy / unconfigured Model(is_reasoning=True) fallback
    fallback_tiers = list(LEGACY_DEFAULT_TIERS)
    if norm_default in ACTIVE_EFFORT_VALUES and norm_default not in fallback_tiers:
        fallback_tiers = sort_canonical_tiers(fallback_tiers + [norm_default])
    default_tier = norm_default if norm_default in fallback_tiers else REASONING_EFFORT_MEDIUM
    return {
        "is_reasoning": True,
        "mode": REASONING_MODE_EFFORT,
        "tiers": fallback_tiers,
        "default": default_tier,
        "has_explicit_tiers": False,
    }


def _snap_tier_to_supported(requested: str, tiers: list[str], mode: str, default: str) -> str:
    if requested in tiers:
        return requested
    if mode == REASONING_MODE_FIXED:
        return REASONING_EFFORT_ON
    if mode == REASONING_MODE_TOGGLE:
        return REASONING_EFFORT_NONE if requested == REASONING_EFFORT_NONE else REASONING_EFFORT_ON

    non_none = [t for t in tiers if t != REASONING_EFFORT_NONE]
    if not non_none:
        return default
    if requested == REASONING_EFFORT_NONE:
        return non_none[0]
    if requested == REASONING_EFFORT_ON:
        return default if default != REASONING_EFFORT_NONE else non_none[0]

    req_rank = EFFORT_RANK.get(requested)
    if req_rank is None:
        return default
    return min(
        non_none,
        key=lambda cand: (
            abs(EFFORT_RANK.get(cand, req_rank) - req_rank),
            0 if cand == default else 1,
            -EFFORT_RANK.get(cand, 0),
        ),
    )


def resolve_reasoning_level(model: Any, raw_level: Any, *, allow_default: bool = True) -> str | None:
    """Resolve and clamp an incoming reasoning_level against a model's capabilities."""
    spec = get_model_reasoning_spec(model)
    if not spec["is_reasoning"]:
        return None

    if raw_level in (None, ""):
        if not allow_default:
            return None
        if not spec["has_explicit_tiers"] and spec["default"] == REASONING_EFFORT_NONE:
            return None
        return spec["default"]

    norm = normalize_tier_name(raw_level)
    if norm is None:
        return spec["default"] if allow_default else None

    # Legacy unconfigured Model(is_reasoning=True) handling:
    # - explicit "none"/"off" resolves to None (omit reasoning_effort on generic providers)
    # - arbitrary standard effort tiers (e.g. "xhigh", "max", "high") pass through directly
    if not spec["has_explicit_tiers"]:
        if norm == REASONING_EFFORT_NONE:
            return None
        if norm == REASONING_EFFORT_ON:
            return spec["default"]
        return norm

    return _snap_tier_to_supported(norm, spec["tiers"], spec["mode"], spec["default"])


def is_openrouter_url(provider_url: str | None) -> bool:
    return "openrouter.ai" in (provider_url or "").lower()


def build_reasoning_request_kwargs(
    model: Any,
    reasoning_level: Any,
    provider_url: str | None = None,
) -> dict[str, Any]:
    """Build upstream provider kwargs (OpenRouter extra_body vs OpenAI reasoning_effort)."""
    spec = get_model_reasoning_spec(model)
    if not spec["is_reasoning"]:
        return {}

    if reasoning_level in (None, ""):
        return {}

    resolved = resolve_reasoning_level(model, reasoning_level, allow_default=False)
    if resolved is None:
        return {}

    if is_openrouter_url(provider_url):
        if spec["mode"] == REASONING_MODE_FIXED:
            return {}
        if spec["mode"] == REASONING_MODE_TOGGLE:
            return {"extra_body": {"reasoning": {"enabled": resolved != REASONING_EFFORT_NONE}}}
        return {"extra_body": {"reasoning": {"effort": resolved}}}

    if spec["mode"] in (REASONING_MODE_FIXED, REASONING_MODE_TOGGLE) or resolved == REASONING_EFFORT_NONE:
        return {}
    return {"reasoning_effort": resolved}


def spec_from_openrouter_reasoning(
    reasoning_meta: dict[str, Any] | None,
    supported_parameters: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any] | None:
    """Derive canonical reasoning_mode, supported_reasoning_efforts, and default_reasoning_effort from OpenRouter metadata."""
    has_reasoning_param = bool(
        isinstance(supported_parameters, (list, tuple, set)) and "reasoning" in supported_parameters
    )
    if not reasoning_meta and not has_reasoning_param:
        return None

    meta = reasoning_meta if isinstance(reasoning_meta, dict) else {}
    mandatory = bool(meta.get("mandatory", False))
    raw_efforts = meta.get("supported_efforts")

    if isinstance(raw_efforts, list) and raw_efforts:
        tiers = [t for t in sort_canonical_tiers(raw_efforts) if t in EFFORT_ORDER]
        if mandatory:
            tiers = [t for t in tiers if t != REASONING_EFFORT_NONE]
        elif REASONING_EFFORT_NONE not in tiers:
            tiers = [REASONING_EFFORT_NONE] + tiers
        default_effort = normalize_tier_name(meta.get("default_effort"))
        default_effort = _pick_default_effort(tiers, preferred=default_effort)
        return {
            "reasoning_mode": REASONING_MODE_EFFORT,
            "supported_reasoning_efforts": tiers,
            "default_reasoning_effort": default_effort,
        }

    if mandatory:
        return {
            "reasoning_mode": REASONING_MODE_FIXED,
            "supported_reasoning_efforts": [REASONING_EFFORT_ON],
            "default_reasoning_effort": REASONING_EFFORT_ON,
        }

    default_enabled = meta.get("default_enabled", True)
    default_effort = REASONING_EFFORT_NONE if default_enabled is False else REASONING_EFFORT_ON
    return {
        "reasoning_mode": REASONING_MODE_TOGGLE,
        "supported_reasoning_efforts": [REASONING_EFFORT_NONE, REASONING_EFFORT_ON],
        "default_reasoning_effort": default_effort,
    }


def normalize_admin_reasoning_config(
    is_reasoning: bool,
    reasoning_mode: Any = None,
    supported_efforts: Any = None,
    default_effort: Any = None,
) -> dict[str, Any]:
    """Validate and normalize Admin/BYOK reasoning fields before persisting to LLMConfig."""
    if not is_reasoning:
        return {
            "reasoning_mode": REASONING_MODE_NONE,
            "supported_reasoning_efforts": [],
            "default_reasoning_effort": REASONING_EFFORT_NONE,
        }

    mode = reasoning_mode.strip().lower() if isinstance(reasoning_mode, str) else ""
    tiers = sort_canonical_tiers(supported_efforts)
    norm_default = normalize_tier_name(default_effort)

    if mode == REASONING_MODE_FIXED:
        return {
            "reasoning_mode": REASONING_MODE_FIXED,
            "supported_reasoning_efforts": [REASONING_EFFORT_ON],
            "default_reasoning_effort": REASONING_EFFORT_ON,
        }

    if mode == REASONING_MODE_TOGGLE:
        toggle_tiers = [REASONING_EFFORT_NONE, REASONING_EFFORT_ON]
        return {
            "reasoning_mode": REASONING_MODE_TOGGLE,
            "supported_reasoning_efforts": toggle_tiers,
            "default_reasoning_effort": norm_default if norm_default in toggle_tiers else REASONING_EFFORT_ON,
        }

    effort_tiers = [t for t in tiers if t in EFFORT_ORDER]
    if not effort_tiers or effort_tiers == [REASONING_EFFORT_NONE]:
        effort_tiers = list(LEGACY_DEFAULT_TIERS)
    return {
        "reasoning_mode": REASONING_MODE_EFFORT,
        "supported_reasoning_efforts": effort_tiers,
        "default_reasoning_effort": _pick_default_effort(effort_tiers, preferred=norm_default),
    }
