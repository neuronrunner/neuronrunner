"""Allow the Django app and the installed MCP SDK to share this namespace."""

from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)
