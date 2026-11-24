"""
Shared helper utilities for chat views.
"""
import logging

logger = logging.getLogger(__name__)

MAX_IMAGE_SIZE = 4096  # Maximum allowed image dimension

# Allowed reaction emojis
ALLOWED_REACTION_EMOJIS = ['❤️', '🔥', '🎨', '👀']


def coerce_int(value, fallback: int) -> int:
    """Safely coerce a value to int, returning fallback on failure."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def coerce_float(value, fallback: float) -> float:
    """Safely coerce a value to float, returning fallback on failure."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def validate_image_dimension(value: int, name: str) -> int:
    """Validate image dimension is within allowed bounds."""
    if value < 1 or value > MAX_IMAGE_SIZE:
        raise ValueError(f"{name} must be between 1 and {MAX_IMAGE_SIZE}")
    return value
