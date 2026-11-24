"""Fetch public search images once for reliable model visual context."""
import base64
from io import BytesIO
import ipaddress
import socket
import time
from urllib.parse import urljoin, urlsplit

from PIL import Image
import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool

MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
MAX_CONTEXT_BYTES = 512 * 1024
MAX_SOURCE_PIXELS = 12_000_000
FETCH_SECONDS = 10


def _public_addresses(host, port):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise ValueError("Image URL must resolve to a public address")
    return addresses


class _PublicConnection:
    def _new_conn(self):
        # Validate and connect the same resolved addresses. A second unchecked
        # DNS lookup in requests would allow a public hostname to rebind locally.
        addresses = _public_addresses(self.host, self.port)
        error = None
        for family, socktype, proto, _, address in addresses:
            connection = socket.socket(family, socktype, proto)
            try:
                connection.settimeout(self.timeout)
                for option in self.socket_options or []:
                    connection.setsockopt(*option)
                if self.source_address:
                    connection.bind(self.source_address)
                connection.connect(address)
                return connection
            except OSError as exc:
                connection.close()
                error = exc
        raise error or OSError("Image host could not be reached")


class _PublicHTTPConnection(_PublicConnection, HTTPConnection):
    pass


class _PublicHTTPSConnection(_PublicConnection, HTTPSConnection):
    pass


class _PublicHTTPPool(HTTPConnectionPool):
    ConnectionCls = _PublicHTTPConnection


class _PublicHTTPSPool(HTTPSConnectionPool):
    ConnectionCls = _PublicHTTPSConnection


class _PublicImageAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = {"http": _PublicHTTPPool, "https": _PublicHTTPSPool}


def _public_url(url):
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Expected a public HTTP/HTTPS image URL")
    if parsed.port not in {None, 80, 443}:
        raise ValueError("Image URLs must use a public HTTP/HTTPS port")
    _public_addresses(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))


def fetch_image(url):
    """Return verified bytes or an explicit per-image error; never start a sandbox."""
    try:
        deadline = time.monotonic() + FETCH_SECONDS
        current = url
        with requests.Session() as session:
            session.trust_env = False
            session.mount("http://", _PublicImageAdapter())
            session.mount("https://", _PublicImageAdapter())
            for redirect in range(4):
                _public_url(current)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Image download timed out")
                with session.get(current, stream=True, allow_redirects=False, timeout=(min(3, remaining), min(5, remaining)), headers={"User-Agent": "NeuronRunner/1.0", "Accept": "image/*"}) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        if redirect == 3 or not response.headers.get("Location"):
                            raise ValueError("Too many image redirects or missing redirect URL")
                        current = urljoin(current, response.headers["Location"])
                        continue
                    response.raise_for_status()
                    if response.status_code != 200:
                        raise ValueError(f"Unexpected HTTP {response.status_code} for image")
                    if int(response.headers.get("Content-Length") or 0) > MAX_DOWNLOAD_BYTES:
                        raise ValueError("Image exceeds the 5 MB download limit")
                    content = bytearray()
                    for chunk in response.iter_content(65536):
                        if time.monotonic() > deadline:
                            raise TimeoutError("Image download timed out")
                        content.extend(chunk)
                        if len(content) > MAX_DOWNLOAD_BYTES:
                            raise ValueError("Image exceeds the 5 MB download limit")
                    break
        with Image.open(BytesIO(content)) as image:
            if image.width * image.height > MAX_SOURCE_PIXELS:
                raise ValueError("Image exceeds the 12 megapixel processing limit")
            image.verify()
        with Image.open(BytesIO(content)) as image:
            image.draft("RGB", (1024, 1024))
            image.thumbnail((1024, 1024))
            image = image.convert("RGB")
            encoded = BytesIO()
            image.save(encoded, format="JPEG", quality=80)
            if encoded.tell() > MAX_CONTEXT_BYTES:
                raise ValueError("Image exceeds the 512 KB visual context limit")
            context_url = "data:image/jpeg;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")
            return {"status": "ok", "image_url": current, "context_url": context_url, "width": image.width, "height": image.height}
    except Exception as exc:
        return {"status": "error", "error": str(exc)[:500]}
