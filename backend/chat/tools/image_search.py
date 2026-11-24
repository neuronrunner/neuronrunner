"""Search with Tavily and attach returned images to the next model request."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from itertools import zip_longest
from urllib.parse import urlsplit

from chat.tools import register
from chat.tools.view_image import MAX_IMAGES
from chat.tools.web_search import WEB_SEARCH_TOOL, handle as search_web
from chat.tools.image_fetch import fetch_image

IMAGE_SEARCH_TOOL = deepcopy(WEB_SEARCH_TOOL)
IMAGE_SEARCH_TOOL["function"].update({
    "name": "image_search",
    "description": (
        "Search for images with Tavily. Use query or batch up to 4 independent queries. "
        "Up to 8 unique returned images are automatically attached to your next model request "
        "as visual context, with URLs and descriptions in the tool result. Inspect them directly; "
        "do not call view_image again for these images. Use Markdown image URLs to show selected images to the user."
    ),
})


def handle(user, arguments):
    result = search_web(user, arguments, include_images=True)
    if "error" in result:
        return result
    searches = result.get("searches", [result])
    images, seen, batches = [], set(), []
    for search in searches:
        candidates = []
        for item in search.pop("images", []):
            if isinstance(item, str):
                item = {"url": item}
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str):
                continue
            url = url.strip()
            try:
                parsed = urlsplit(url)
                if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
                    continue
            except ValueError:
                continue
            if url in seen:
                continue
            seen.add(url)
            candidates.append({
                "source": url,
                "description": str(item.get("description") or "")[:1500],
                "query": search.get("query", ""),
            })
        batches.append(candidates)
    # Give each query a share of the image budget, instead of letting the first
    # query consume every slot. Try replacements when individual URLs fail.
    candidates = [item for row in zip_longest(*batches) for item in row if item is not None][:MAX_IMAGES * 2]
    errors = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        start = 0
        while start < len(candidates):
            batch = candidates[start:start + min(4, MAX_IMAGES - len(images))]
            start += len(batch)
            for candidate, opened in zip(batch, pool.map(fetch_image, [item["source"] for item in batch])):
                image = {**candidate, **opened}
                (images if image.get("status") == "ok" else errors).append(image)
            if len(images) >= MAX_IMAGES:
                break
    result["images"] = images
    result["image_count"] = len(images)
    result["image_errors"] = errors
    if errors:
        result["status"] = "partial" if images or result.get("count") else "error"
    result["message"] = (
        f"{len(images)} image(s) attached to your visual context. Inspect them directly without calling view_image."
        if images else "No images could be opened. Use the available web results or try a different search query."
    )
    if errors:
        result["message"] += f" {len(errors)} image(s) failed to open; see image_errors."
    return result


register("image_search", handle)
