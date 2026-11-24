"""Bounded, public-HTTPS requests for untrusted OAuth discovery documents."""
import ipaddress
import socket
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPSConnection
from urllib3.connectionpool import HTTPSConnectionPool


def public_url(url):
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.fragment or parsed.port not in (None, 443)):
            raise ValueError
    except (TypeError, ValueError):
        raise ValueError('OAuth endpoints must use a public HTTPS URL.') from None
    return url


class PublicHTTPSConnection(HTTPSConnection):
    def _new_conn(self):
        # Connect the addresses we validated, rather than resolving twice (DNS rebinding).
        addresses = socket.getaddrinfo(self.host, self.port, family=socket.AF_INET, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError('OAuth endpoints must resolve to public addresses.')
        last_error = None
        for family, socktype, proto, _, address in addresses:
            connection = socket.socket(family, socktype, proto)
            try:
                connection.settimeout(self.timeout)
                for option in self.socket_options or []:
                    connection.setsockopt(*option)
                connection.connect(address)
                return connection
            except OSError as exc:
                connection.close()
                last_error = exc
        raise last_error or OSError('OAuth server could not be reached.')


class PublicHTTPSPool(HTTPSConnectionPool):
    ConnectionCls = PublicHTTPSConnection


class PublicHTTPSAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = {'https': PublicHTTPSPool}


def oauth_request(method, url, **kwargs):
    public_url(url)
    with requests.Session() as session:
        session.trust_env = False
        session.mount('https://', PublicHTTPSAdapter())
        with session.request(method, url, timeout=(5, 15), allow_redirects=False, stream=True, **kwargs) as response:
            # Never forward authorization codes, client secrets or tokens across redirects.
            if 300 <= response.status_code < 400:
                raise ValueError('OAuth endpoint redirects are not supported. Use its canonical URL.')
            content = bytearray()
            for chunk in response.iter_content(16384):
                content.extend(chunk)
                if len(content) > 1024 * 1024:
                    raise ValueError('OAuth server response is too large.')
            response._content = bytes(content)
            response._content_consumed = True
            return response
