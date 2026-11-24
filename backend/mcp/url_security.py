"""Validate remote MCP endpoints before the backend makes outbound requests."""
import ipaddress
import socket
from urllib.parse import urlsplit

from django.conf import settings


class UnsafeMCPURL(ValueError):
    """Raised when a remote MCP URL could reach a non-public destination."""


def validate_mcp_url(url):
    """Require a public HTTPS endpoint unless private URLs are explicitly allowed."""
    if not getattr(settings, "MCP_URL_VALIDATION_ENABLED", True):
        return url
    try:
        parsed = urlsplit(url)
        if any(char in url for char in "{}<>"):
            raise UnsafeMCPURL("Replace placeholders in the MCP server URL before connecting.")
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
            or parsed.port not in (None, 443)
        ):
            raise UnsafeMCPURL("MCP servers must use a public HTTPS URL with no credentials, fragment, or custom port.")
    except (TypeError, ValueError):
        raise UnsafeMCPURL("Enter a valid public HTTPS MCP server URL.") from None

    if getattr(settings, "MCP_ALLOW_PRIVATE_URLS", False):
        return url

    try:
        addresses = socket.getaddrinfo(parsed.hostname, 443, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except (OSError, ValueError):
        raise UnsafeMCPURL("The MCP server hostname could not be resolved.") from None
    if not addresses:
        raise UnsafeMCPURL("The MCP server hostname could not be resolved.")
    for family, _, _, _, sockaddr in addresses:
        try:
            address = ipaddress.ip_address(sockaddr[0])
        except (ValueError, IndexError):
            raise UnsafeMCPURL("The MCP server hostname resolved to an invalid address.") from None
        if not address.is_global:
            raise UnsafeMCPURL("The MCP server must resolve to a public internet address.")
    return url
