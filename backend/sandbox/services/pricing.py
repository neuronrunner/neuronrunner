"""Workspace sandbox runtime limits helpers."""
from __future__ import annotations

from decimal import Decimal


def gpu_base_cost_per_sec(gpu: str) -> Decimal:
    return Decimal("0")


def margin_for_tier(tier: str) -> Decimal:
    return Decimal("0")


def cost_breakdown(gpu: str, duration_seconds: float, tier: str) -> tuple[Decimal, Decimal, Decimal]:
    return Decimal("0"), Decimal("0"), Decimal("0")


def tier_allows_gpu(tier: str, gpu: str) -> bool:
    return False


def max_duration_for_tier(tier: str) -> int:
    return 360


def resolve_user_tier(user) -> str:
    return "default"
