import base64
import io

from django.core.cache import cache
from PIL import Image, ImageFilter, ImageOps


def build_blur_data_url(
    image_field,
    *,
    cache_prefix: str,
    size: tuple[int, int] = (24, 24),
    blur_radius: float = 1.2,
    quality: int = 38,
) -> str | None:
    """Return a tiny blurred JPEG data URL for an ImageField/FileField value."""
    if not image_field:
        return None

    image_name = getattr(image_field, "name", None)
    if not image_name:
        return None

    cache_key = f"{cache_prefix}:{image_name}:{size[0]}x{size[1]}:{blur_radius}:{quality}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    try:
        image_field.open("rb")
        with Image.open(image_field) as img:
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
            img.thumbnail(size, Image.Resampling.LANCZOS)
            img = img.filter(ImageFilter.GaussianBlur(radius=blur_radius))

            buffer = io.BytesIO()
            img.save(buffer, format="JPEG", optimize=True, quality=quality)
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            data_url = f"data:image/jpeg;base64,{encoded}"

        cache.set(cache_key, data_url, timeout=60 * 60 * 24 * 7)
        return data_url
    except Exception:
        return None
    finally:
        try:
            image_field.close()
        except Exception:
            pass
