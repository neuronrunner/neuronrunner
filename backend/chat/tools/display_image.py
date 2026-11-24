"""Display existing images in chat without creating a project or runtime."""
import base64
from copy import copy
from io import BytesIO
import mimetypes
import posixpath
from urllib.parse import urlsplit

from PIL import Image, UnidentifiedImageError


DISPLAY_IMAGE_TOOL = {
    "type": "function",
    "function": {
        "name": "display_image",
        "description": (
            "Show an existing image in the user's chat UI from an HTTP/HTTPS image URL "
            "or a workspace file path. Absolute paths start with /workspace/; relative "
            "paths are relative to the conversation's project directory. Use this to "
            "present screenshots, photos, plots, or other images. This displays the image "
            "to the user; it does not analyze it. Do not repeat the image as Markdown afterwards."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "source": {"type": "string", "description": "HTTP/HTTPS image URL or workspace image file path."},
                "title": {"type": "string", "description": "Optional caption for the image."},
            },
            "required": ["source"],
        },
    },
}

MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_MIMES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif", "BMP": "image/bmp", "AVIF": "image/avif"}


def handle_display_image(user, arguments):
    source = arguments.get("source")
    if not isinstance(source, str) or not source.strip():
        return {"error": "source is required: provide an image URL or workspace file path."}
    source = source.strip()
    title = arguments.get("title")
    title = title.strip() if isinstance(title, str) else ""
    result = {"status": "ok", "return_type": "image", "title": title or "Image", "message": "Image sent to the chat UI. Do not embed it again in your response."}
    try:
        url = urlsplit(source)
    except ValueError:
        return {"error": "Invalid image URL."}
    if url.scheme.lower() in {"http", "https"}:
        if not url.hostname:
            return {"error": "Invalid image URL."}
        mime = mimetypes.guess_type(url.path)[0]
        return {**result, "content_url": url.geturl(), "mime": mime if mime and mime.startswith("image/") else None}
    if url.scheme or source.startswith("//"):
        return {"error": "Use an HTTP/HTTPS image URL or a path inside /workspace."}

    from chat.builtin_tools import _ensure_file_tool_args
    from sandbox.services.volume_tools import read_file

    resolved = _ensure_file_tool_args("display_image", user, arguments)
    if "error" in resolved:
        return resolved
    project = resolved["sandbox"]
    base = project.filesystem_path or f"/workspace/{project.slug}"
    path = posixpath.normpath(source if source.startswith("/") else posixpath.join(base, source))
    if not path.startswith("/workspace/"):
        return {"error": "Image files must be inside /workspace."}

    # Absolute paths refer to the shared runtime, not a second project-relative root.
    root = project.workspace.projects.filter(filesystem_path="/workspace").first() if project.workspace_id else None
    if root is None:
        root = copy(project)
        root.filesystem_path = "/workspace"
    try:
        content = read_file(root, path)
    except ValueError:
        return {"error": "Image files must be inside the current workspace."}
    if content is None:
        filename = posixpath.basename(path)
        uploads_path = f"/workspace/.uploads/{filename}"
        if path != uploads_path:
            try:
                content = read_file(root, uploads_path)
                if content is not None:
                    path = uploads_path
            except Exception:
                pass
    if content is None:
        return {"error": f"Image not found: {path}"}
    if len(content) > MAX_IMAGE_BYTES:
        return {"error": "The image exceeds the 10 MB preview limit."}
    try:
        with Image.open(BytesIO(content)) as image:
            mime = IMAGE_MIMES.get(image.format)
            width, height = image.size
            image.verify()
        if not mime:
            return {"error": "Unsupported image format. Use PNG, JPEG, WebP, GIF, BMP, or AVIF."}
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError):
        return {"error": f"This file is not a valid image: {path}"}
    return {
        **result, "title": title or posixpath.basename(path), "path": path,
        "content_url": f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}",
        "mime": mime, "size_bytes": len(content), "width": width, "height": height,
    }


def model_tool_result(name, result):
    """Keep image bytes in the UI/persisted result, out of the model's text context."""
    if name == "image_search" and isinstance(result, dict):
        text = {key: value for key, value in result.items() if key != "context_url"}
        if isinstance(text.get("images"), list):
            text["images"] = [model_tool_result(name, image) for image in text["images"]]
        return text
    if name in {"view_image", "desktop"} and isinstance(result, dict):
        text = {key: value for key, value in result.items() if key != "image_url"}
        if isinstance(text.get("images"), list):
            text["images"] = [model_tool_result(name, image) for image in text["images"]]
        return text
    if name == "display_image" and isinstance(result, dict) and str(result.get("content_url", "")).startswith("data:image/"):
        return {key: value for key, value in result.items() if key != "content_url"}
    return result
