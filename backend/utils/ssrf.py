"""
SSRF Protection Utilities.

Validates that external URLs provided by users or clients point only to
publicly routable Internet addresses and not to private, local, or cloud metadata endpoints.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit


FORBIDDEN_HOSTS = {
    'localhost',
    'metadata.google.internal',
    'instance-data',
}


def is_safe_external_url(url: str, allowed_schemes: tuple[str, ...] = ('http', 'https')) -> tuple[bool, str | None]:
    """
    Validate that a URL uses an allowed scheme and does NOT resolve to a
    loopback, private, link-local, multicast, or cloud metadata address.

    Returns:
        (is_safe, error_message)
    """
    if not url or not isinstance(url, str):
        return False, "URL is required"

    try:
        parsed = urlsplit(url.strip())
    except Exception:
        return False, "Invalid URL format"

    if parsed.scheme.lower() not in allowed_schemes:
        return False, f"URL scheme must be one of: {', '.join(allowed_schemes)}"

    hostname = parsed.hostname
    if not hostname:
        return False, "URL must contain a valid hostname"

    hostname_lower = hostname.lower().strip('. ')
    if hostname_lower in FORBIDDEN_HOSTS or hostname_lower.endswith('.localhost') or hostname_lower.endswith('.internal'):
        return False, "Access to internal or local hostnames is forbidden"

    # Check if hostname is directly an IP literal
    try:
        ip = ipaddress.ip_address(hostname_lower)
        if _is_blocked_ip(ip):
            return False, "Access to private or local IP addresses is forbidden"
    except ValueError:
        pass

    # Resolve DNS to all associated IP addresses
    try:
        # Port 80/443 doesn't matter for getaddrinfo address family resolution
        port = parsed.port or (443 if parsed.scheme.lower() == 'https' else 80)
        addr_info = socket.getaddrinfo(hostname, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        return False, f"Unable to resolve host: {hostname}"
    except Exception as exc:
        return False, f"Host resolution error: {exc}"

    if not addr_info:
        return False, f"Unable to resolve host: {hostname}"

    for family, _, _, _, sockaddr in addr_info:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
            if _is_blocked_ip(ip):
                return False, f"Target resolves to forbidden or private IP: {ip_str}"
        except ValueError:
            return False, f"Invalid resolved IP address: {ip_str}"

    return True, None


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Check if an IP is private, loopback, link-local, multicast, or reserved."""
    # Check for IPv4 mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped

    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True

    # Cloud metadata service (169.254.169.254) is link-local, but explicitly ensure
    if str(ip) in ('169.254.169.254', '::ffff:169.254.169.254'):
        return True

    return False
