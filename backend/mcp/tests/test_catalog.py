import json
import os
import re
from django.test import SimpleTestCase

from mcp.catalog import format_mcp_server_name, format_tool_name, get_connector_catalog


class MCPCatalogTests(SimpleTestCase):
    def test_catalog_loads_100_connectors(self):
        catalog = get_connector_catalog()
        self.assertGreaterEqual(len(catalog), 100)

    def test_all_connectors_match_their_catalog_name(self):
        data_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "connectors.json")
        with open(data_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        for c in data["connectors"]:
            server_name = re.sub(r"[^a-zA-Z0-9_-]", "_", c["id"])[:100]
            self.assertEqual(format_mcp_server_name(server_name), c["name"])

    def test_format_tool_name_playwright(self):
        self.assertEqual(
            format_tool_name("mcp__io_github_microsoft_playwright-mcp__browser_navigate"),
            "Playwright · Browser Navigate",
        )
        self.assertEqual(
            format_tool_name("mcp__io_github_microsoft_playwright-mcp__browser_click"),
            "Playwright · Browser Click",
        )
        self.assertEqual(
            format_tool_name("mcp__io_github_microsoft_playwright-mcp__browser_snapshot"),
            "Playwright · Browser Snapshot",
        )
        self.assertEqual(
            format_tool_name("mcp__io_github_microsoft_playwright-mcp__browser_find"),
            "Playwright · Browser Find",
        )
        self.assertEqual(
            format_tool_name("mcp__io_github_microsoft_playwright-mcp__browser_evaluate"),
            "Playwright · Browser Evaluate",
        )

    def test_format_tool_name_builtin(self):
        self.assertEqual(format_tool_name("shell_exec"), "Shell Exec")
        self.assertEqual(format_tool_name("file_read"), "File Read")
        self.assertEqual(format_tool_name("memory_search"), "Memory Search")
        self.assertEqual(format_tool_name("view_image"), "View Image")

    def test_format_tool_name_custom_server(self):
        self.assertEqual(
            format_tool_name("mcp__my_custom_server__run_task"),
            "My Custom Server · Run Task",
        )
