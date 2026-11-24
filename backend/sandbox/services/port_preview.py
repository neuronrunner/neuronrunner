"""Isolated local port previews for Docker workspace containers."""
from __future__ import annotations

import json
import secrets
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from django.conf import settings
from django.core.cache import cache
from rest_framework.exceptions import APIException

from .docker_sandbox import get_container_ip
from .sandbox_session import get_sandbox_manager

SYSTEM_PORTS = {22, 5901, 6001, 6080, 7111, 7681, 8765, 8766, 8767, 9222}
PREVIEW_TOKEN_TTL_SECONDS = 900  # 15 minutes
PREVIEW_CACHE_PREFIX = "nr:docker_preview:"
PREVIEW_PORT_INDEX_PREFIX = "nr:docker_preview_port:"


class PreviewPortNotListening(APIException):
    status_code = 409
    default_code = "port_not_listening"


def _listening_ports(runtime) -> list[int]:
    script = r"""
import concurrent.futures, json, socket

SYSTEM_PORTS = {22, 5901, 6001, 6080, 7111, 7681, 8765, 8766, 8767, 9222}
candidates = set()

for path in ['/proc/net/tcp', '/proc/net/tcp6']:
    try:
        with open(path) as file:
            for line in list(file)[1:]:
                fields = line.split()
                if len(fields) > 3 and fields[3] == '0A':
                    candidates.add(int(fields[1].rsplit(':', 1)[1], 16))
    except OSError:
        pass

candidates.difference_update(SYSTEM_PORTS)

def check_http(port, timeout=0.8):
    for host in ('127.0.0.1', '::1'):
        try:
            family = socket.AF_INET6 if ':' in host else socket.AF_INET
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                s.connect((host, port))
                s.sendall(
                    b'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n'
                    b'User-Agent: neuronrunner-port-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n'
                )
                data = s.recv(16)
                if data.upper().startswith(b'HTTP/'):
                    parts = data.split()
                    if len(parts) >= 2 and parts[1] == b'426':
                        return False
                    return True
        except Exception:
            pass
    return False

http_ports = []
if candidates:
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, len(candidates))) as executor:
        for port, is_http in zip(candidates, executor.map(check_http, candidates)):
            if is_http:
                http_ports.append(port)

print(json.dumps(sorted(http_ports)))
"""
    process = runtime.exec("python3", "-c", script, timeout=10)
    raw = process.stdout.read()
    output = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    if process.wait(10) != 0:
        raise RuntimeError("Could not inspect workspace ports")
    return json.loads(output)


def _port_key(project, port: int) -> str:
    """Preview tokens are per runtime: the same port may serve different apps in two runtimes."""
    from .sandbox_session import selected_runtime

    runtime_name = selected_runtime()
    suffix = f"@{runtime_name}" if runtime_name else ""
    return f"{PREVIEW_PORT_INDEX_PREFIX}{project.uuid}:{port}{suffix}"


def listening_ports(project) -> list[int]:
    from core.extensions import registry as ext_registry

    if ext_registry.runtime.list_preview_ports is not None:
        ext_result = ext_registry.runtime.list_preview_ports(project)
        if ext_result is not None:
            return ext_result
    from .sandbox_session import selected_runtime

    if not project.sandbox_object_id and not selected_runtime():
        return []
    runtime = get_sandbox_manager().get_or_create(project)
    if runtime.poll() is not None:
        return []
    return _listening_ports(runtime)


def create_port_preview(project, user, port: int, path: str = "/") -> dict:
    from core.extensions import registry as ext_registry

    if port in SYSTEM_PORTS:
        raise PreviewPortNotListening(
            f"Port {port} is reserved for workspace services and cannot be previewed."
        )
    if ext_registry.runtime.create_port_preview is not None:
        ext_result = ext_registry.runtime.create_port_preview(project, user, port, path)
        if ext_result is not None:
            return ext_result
    runtime = get_sandbox_manager().get_or_create(project)
    ports = _listening_ports(runtime)
    if port not in ports:
        raise PreviewPortNotListening(
            f"No web server is listening on workspace port {port}. "
            "Start your app in the workspace terminal (for example, npm run dev), "
            "then open the port shown in its output."
        )

    container_name = getattr(runtime, "container_name", None) or getattr(runtime, "object_id", "")
    container_ip = get_container_ip(container_name)
    if not container_ip:
        raise RuntimeError("Could not resolve workspace container network address.")

    port_key = _port_key(project, port)
    existing_token = cache.get(port_key)
    token = existing_token or secrets.token_urlsafe(32)

    cache.set(
        f"{PREVIEW_CACHE_PREFIX}{token}",
        {
            "container_name": container_name,
            "container_ip": container_ip,
            "port": port,
            "project_uuid": str(project.uuid),
            "user_id": str(getattr(user, "pk", "")),
        },
        timeout=PREVIEW_TOKEN_TTL_SECONDS,
    )
    cache.set(port_key, token, timeout=PREVIEW_TOKEN_TTL_SECONDS)

    base = getattr(settings, "PREVIEW_PROXY_BASE_URL", "http://127.0.0.1:8090").rstrip("/")
    parsed_base = urlsplit(base)
    target = urlsplit(path)
    query = [(k, v) for k, v in parse_qsl(target.query, keep_blank_values=True) if k != "preview_token"]
    clean_path = urlunsplit(("", "", target.path or "/", urlencode(query), target.fragment))
    bootstrap = urlencode({"preview_token": token, "path": clean_path})

    return {
        "port": port,
        "url": urlunsplit((parsed_base.scheme, parsed_base.netloc, "/_preview_auth", bootstrap, "")),
        "origin": urlunsplit((parsed_base.scheme, parsed_base.netloc, "", "", "")),
        "path": clean_path,
    }


def close_port_preview(project, port: int) -> dict:
    from core.extensions import registry as ext_registry

    if ext_registry.runtime.close_port_preview is not None:
        ext_result = ext_registry.runtime.close_port_preview(project, port)
        if ext_result is not None:
            return ext_result
    port_key = _port_key(project, port)
    token = cache.get(port_key)
    if token:
        cache.delete(f"{PREVIEW_CACHE_PREFIX}{token}")
        cache.delete(port_key)
    return {"closed": True, "port": port}
