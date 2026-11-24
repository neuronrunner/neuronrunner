import json
import os
import re
from functools import lru_cache

CATALOG_PATHS = [
    os.path.join(os.path.dirname(__file__), "data", "connectors.json"),
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "src", "data", "connectors.json")),
]


@lru_cache(maxsize=1)
def get_connector_catalog() -> dict:
    """Load connectorServerName -> human readable name mapping from connectors.json."""
    for path in CATALOG_PATHS:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    mapping = {}
                    for c in data.get("connectors", []):
                        srv = re.sub(r"[^a-zA-Z0-9_-]", "_", c.get("id", ""))[:100]
                        if srv and c.get("name"):
                            mapping[srv] = c["name"]
                    if mapping:
                        return mapping
            except Exception:
                continue
    return {}


def title_case_words(value: str) -> str:
    return ' '.join(w[0].upper() + w[1:] for w in re.split(r'[_-]+', value) if w)


def format_mcp_server_name(raw_server: str) -> str:
    trimmed = (raw_server or "").strip()
    if not trimmed:
        return ""

    catalog = get_connector_catalog()
    if trimmed in catalog:
        return catalog[trimmed]

    cleaned = trimmed
    gh_match = re.match(r'^(?:io|com|org|net|app|dev|ai|co)_github_([^_]+)_(.+)$', cleaned, re.I)
    if gh_match:
        owner, repo = gh_match.group(1), gh_match.group(2)
        cleaned = re.sub(r'[-_]labs$', '', owner, flags=re.I) if re.fullmatch(r'(?:mcp(?:[-_]server)?|server)', repo, re.I) else repo
    else:
        domain_match = re.match(r'^(?:io|com|org|net|app|dev|ai|co)_([^_]+)_(.+)$', cleaned, re.I)
        if domain_match:
            vendor, rest = domain_match.group(1), domain_match.group(2)
            cleaned = vendor if re.fullmatch(r'(?:mcp(?:[-_](?:mcp|server))*|server)', rest, re.I) else rest
        else:
            npm_scoped = re.match(r'^npm__?[^_]+_(.+)$', cleaned, re.I)
            if npm_scoped:
                cleaned = npm_scoped.group(1)
            elif cleaned.lower().startswith('npm_'):
                cleaned = cleaned[4:]

    cleaned = re.sub(r'^(?:mcp[-_](?:server[-_])?)+', '', cleaned, flags=re.I)
    cleaned = re.sub(r'(?:[-_]mcp(?:[-_]server)?)+$', '', cleaned, flags=re.I)
    return title_case_words(cleaned or trimmed)


def format_tool_name(name: str) -> str:
    """Format tool names for display.
    Built-in: memory_search → Memory Search
    MCP: mcp__io_github_microsoft_playwright-mcp__browser_navigate → Playwright · Browser Navigate
    """
    if not name:
        return name
    if name.startswith('mcp__'):
        parts = name[5:].split('__', 1)
        if len(parts) == 2:
            server_part, tool_part = parts
            server_label = format_mcp_server_name(server_part)
            tool_label = title_case_words(tool_part)
            if server_label and tool_label.lower().startswith(server_label.lower() + ' '):
                tool_label = tool_label[len(server_label):].lstrip()
            if server_label and tool_label and server_label.lower() != tool_label.lower():
                return f'{server_label} · {tool_label}'
            return tool_label or server_label or name
    return ' '.join(word.capitalize() for word in name.split('_'))
