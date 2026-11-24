"""Lightweight isolated-origin HTTP reverse proxy for local Docker workspace previews.

Runs on a separate port (default 8090) so untrusted user web applications inside
sandbox containers never share an origin with the NeuronRunner API or frontend.
"""
from __future__ import annotations

import http.client
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from django.core.cache import cache

from .port_preview import PREVIEW_CACHE_PREFIX

PREVIEW_COOKIE = "_neuronrunner_preview_token"
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
}


class DockerPreviewProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def _extract_token(self) -> str:
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return ""
        jar = SimpleCookie()
        try:
            jar.load(raw_cookie)
        except Exception:
            return ""
        morsel = jar.get(PREVIEW_COOKIE)
        return morsel.value if morsel else ""

    def _handle_auth_bootstrap(self, query: str) -> None:
        params = parse_qs(query, keep_blank_values=True)
        token = (params.get("preview_token") or [""])[0]
        target_path = (params.get("path") or ["/"])[0]
        if not target_path.startswith("/") or target_path.startswith("//"):
            target_path = "/"
        if not token or not cache.get(f"{PREVIEW_CACHE_PREFIX}{token}"):
            self.send_error(403, "Invalid or expired preview token")
            return
        self.send_response(302)
        self.send_header("Set-Cookie", f"{PREVIEW_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax")
        self.send_header("Location", target_path)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _proxy(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/_preview_auth":
            self._handle_auth_bootstrap(parsed.query)
            return

        token = self._extract_token()
        entry = cache.get(f"{PREVIEW_CACHE_PREFIX}{token}") if token else None
        if not entry:
            self.send_error(403, "Preview session expired or unauthorized")
            return

        target_host = entry["container_ip"]
        target_port = int(entry["port"])
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(content_length) if content_length > 0 else None

        forward_headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in HOP_BY_HOP and k.lower() != "cookie"
        }
        forward_headers["Host"] = f"127.0.0.1:{target_port}"

        conn = http.client.HTTPConnection(target_host, target_port, timeout=30)
        try:
            conn.request(self.command, self.path, body=body, headers=forward_headers)
            resp = conn.getresponse()
            data = resp.read()
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in HOP_BY_HOP and k.lower() != "content-length":
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if data and self.command != "HEAD":
                self.wfile.write(data)
        except Exception as exc:
            msg = f"Preview upstream error: {exc}".encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
        finally:
            conn.close()

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_PATCH(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def do_HEAD(self):
        self._proxy()

    def do_OPTIONS(self):
        self._proxy()


def run_preview_proxy_server(host: str = "0.0.0.0", port: int = 8090) -> None:
    server = ThreadingHTTPServer((host, port), DockerPreviewProxyHandler)
    try:
        server.serve_forever()
    finally:
        server.server_close()
