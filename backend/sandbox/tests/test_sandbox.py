"""Tests for sandbox file tools.

Covers:
  1. Path normalization and traversal protection
  2. File read/write/patch operations
  3. File content search
  4. Shell command execution
  5. Directory listing and glob
  6. HTTP requests to arbitrary domains
  7. File tool dispatcher routing
"""
import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.test import TestCase, override_settings

from sandbox.services.file_tools import (
    FileNotFoundInSandbox,
    FileToolError,
    PathTraversalError,
    _normalize_path,
    dispatch_file_tool,
    file_content_search,
    file_patch,
    file_read,
    file_write,
    glob_files,
    http_request,
    list_directory,
    shell_exec,
)


class _WorkspaceTestBase(TestCase):
    """Creates a temp workspace and patches WORKSPACE_ROOT for each test."""

    def setUp(self):
        self._saved_cwd = os.getcwd()
        self._tmp_root = Path(tempfile.mkdtemp())
        self._workspace = self._tmp_root / "workspace"
        self._workspace.mkdir(parents=True)
        self._patcher = patch(
            "sandbox.services.file_tools.WORKSPACE_ROOT",
            str(self._workspace),
        )
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()
        os.chdir(self._saved_cwd)
        shutil.rmtree(self._tmp_root)


class NormalizePathTests(_WorkspaceTestBase):
    """Path normalisation & directory-traversal prevention."""

    def test_relative_path_resolves_under_workspace(self):
        result = _normalize_path("foo/bar")
        self.assertEqual(result, self._workspace / "foo/bar")

    def test_absolute_path_within_workspace(self):
        target = self._workspace / "foo"
        target.mkdir()
        result = _normalize_path(str(target))
        self.assertEqual(result, target)

    def test_path_traversal_raises_error(self):
        with self.assertRaises(PathTraversalError):
            _normalize_path("../../etc/passwd")

    def test_absolute_path_outside_workspace_raises_error(self):
        with self.assertRaises(PathTraversalError):
            _normalize_path("/etc/passwd")


class FileReadTests(_WorkspaceTestBase):
    """file_read() unit tests."""

    def setUp(self):
        super().setUp()
        self.test_file = self._workspace / "test.txt"
        self.test_file.write_text("hello world\nline 2\nline 3\n")

    def test_read_full_file(self):
        result = file_read("test.txt")
        self.assertEqual(result["content"], "hello world\nline 2\nline 3\n")
        self.assertEqual(result["path"], "test.txt")
        self.assertEqual(result["size"], 26)
        self.assertEqual(result["mime"], "text/plain")

    def test_read_with_offset(self):
        result = file_read("test.txt", offset=12)
        self.assertEqual(result["content"], "line 2\nline 3\n")

    def test_read_with_limit(self):
        result = file_read("test.txt", limit=5)
        self.assertEqual(result["content"], "hello")

    def test_read_with_offset_and_limit(self):
        result = file_read("test.txt", offset=6, limit=5)
        self.assertEqual(result["content"], "world")

    def test_read_nonexistent_file_raises(self):
        with self.assertRaises(FileNotFoundInSandbox):
            file_read("nonexistent.txt")


class FileWriteTests(_WorkspaceTestBase):
    """file_write() unit tests."""

    def test_write_new_file(self):
        result = file_write("new.txt", "hello world")
        self.assertEqual(result["path"], "new.txt")
        self.assertEqual(result["bytes_written"], 11)
        self.assertEqual(result["mode"], "w")
        self.assertEqual(
            (self._workspace / "new.txt").read_text(),
            "hello world",
        )

    def test_write_creates_parent_directories(self):
        result = file_write("sub/deep/file.txt", "nested")
        self.assertTrue((self._workspace / "sub" / "deep" / "file.txt").exists())
        self.assertEqual(result["path"], "sub/deep/file.txt")

    def test_overwrite_existing_file(self):
        (self._workspace / "existing.txt").write_text("old")
        file_write("existing.txt", "new content")
        self.assertEqual(
            (self._workspace / "existing.txt").read_text(),
            "new content",
        )

    def test_append_mode(self):
        (self._workspace / "log.txt").write_text("line1\n")
        file_write("log.txt", "line2\n", mode="a")
        self.assertEqual(
            (self._workspace / "log.txt").read_text(),
            "line1\nline2\n",
        )

    def test_write_outside_workspace_raises(self):
        with self.assertRaises(PathTraversalError):
            file_write("/tmp/evil.txt", "bad")


class FilePatchTests(_WorkspaceTestBase):
    """file_patch() find-and-replace unit tests."""

    def setUp(self):
        super().setUp()
        self.test_file = self._workspace / "patch.txt"
        self.test_file.write_text("hello world\nhello there\n")

    def test_single_replace(self):
        # Use content with exactly 1 occurrence so count=1 succeeds
        self.test_file.write_text("hello world\n")
        result = file_patch("patch.txt", "hello", "hi", count=1)
        self.assertEqual(result["replacements"], 1)
        self.assertEqual(
            (self._workspace / "patch.txt").read_text(),
            "hi world\n",
        )

    def test_replace_all(self):
        result = file_patch("patch.txt", "hello", "hi", count=0)
        self.assertEqual(result["replacements"], 2)
        self.assertEqual(
            (self._workspace / "patch.txt").read_text(),
            "hi world\nhi there\n",
        )

    def test_pattern_not_found_raises(self):
        with self.assertRaises(FileToolError):
            file_patch("patch.txt", "nonexistent", "x")

    def test_count_exceeds_occurrences_raises(self):
        # Content has 2 "hello" occurrences; count=1 triggers safety check
        with self.assertRaises(FileToolError):
            file_patch("patch.txt", "hello", "hi", count=1)

    def test_file_not_found_raises(self):
        with self.assertRaises(FileNotFoundInSandbox):
            file_patch("missing.txt", "a", "b")


class FileContentSearchTests(_WorkspaceTestBase):
    """file_content_search() unit tests."""

    def setUp(self):
        super().setUp()
        (self._workspace / "file1.txt").write_text("hello world\npython is great\n")
        (self._workspace / "file2.txt").write_text("goodbye world\n")
        sub = self._workspace / "subdir"
        sub.mkdir()
        (sub / "file3.txt").write_text("nested python file\n")
        (sub / "data.bin").write_bytes(b"\x00\x01\x02\x03python\xff")

    def test_search_recursive_finds_all_matches(self):
        result = file_content_search("python")
        self.assertEqual(result["count"], 2)

    def test_search_non_recursive_only_top_level(self):
        result = file_content_search("python", recursive=False)
        self.assertEqual(result["count"], 1)

    def test_search_case_insensitive(self):
        result = file_content_search("HELLO")
        self.assertEqual(result["count"], 1)

    def test_no_matches(self):
        result = file_content_search("zzz_nonexistent_zzz")
        self.assertEqual(result["count"], 0)

    def test_search_in_subdirectory(self):
        result = file_content_search("nested", directory="subdir")
        self.assertEqual(result["count"], 1)

    def test_binary_file_skipped(self):
        result = file_content_search("python")
        # the binary file (data.bin) should be skipped due to UnicodeDecodeError
        self.assertEqual(result["count"], 2)


class ShellExecTests(_WorkspaceTestBase):
    """shell_exec() unit tests (runs real subprocesses)."""

    def test_echo_command(self):
        result = shell_exec("echo hello world")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("hello world", result["stdout"])

    def test_non_zero_exit_code(self):
        result = shell_exec("exit 42")
        self.assertEqual(result["exit_code"], 42)

    def test_stderr_captured(self):
        result = shell_exec("echo error >&2")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("error", result["stderr"])

    def test_timeout_expires(self):
        result = shell_exec("sleep 10", timeout=1)
        self.assertEqual(result["exit_code"], -1)
        self.assertIn("timed out", result["stderr"].lower())

    def test_cwd_changes_directory(self):
        sub = self._workspace / "subdir"
        sub.mkdir()
        (sub / "marker.txt").write_text("here")
        result = shell_exec("ls marker.txt", cwd="subdir")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("marker.txt", result["stdout"])

    def test_cwd_in_result_is_relative(self):
        result = shell_exec("pwd")
        self.assertEqual(result["cwd"], ".")


class ListDirectoryTests(_WorkspaceTestBase):
    """list_directory() unit tests."""

    def setUp(self):
        super().setUp()
        (self._workspace / "file_a.txt").write_text("a")
        (self._workspace / "file_b.txt").write_text("b")
        sub = self._workspace / "sub"
        sub.mkdir()
        (sub / "nested.txt").write_text("nested")

    def test_list_root_non_recursive(self):
        result = list_directory()
        self.assertEqual(result["count"], 3)
        names = {i["name"] for i in result["items"]}
        self.assertIn("file_a.txt", names)
        self.assertIn("file_b.txt", names)
        self.assertIn("sub", names)

    def test_directory_not_found_raises(self):
        with self.assertRaises(FileNotFoundInSandbox):
            list_directory("nonexistent")


class GlobFilesTests(_WorkspaceTestBase):
    """glob_files() unit tests."""

    def setUp(self):
        super().setUp()
        (self._workspace / "script.py").write_text("print('hi')")
        (self._workspace / "data.txt").write_text("data")
        sub = self._workspace / "sub"
        sub.mkdir()
        (sub / "helper.py").write_text("def help(): pass")
        (sub / "readme.md").write_text("# Readme")

    def test_glob_all_py_files_recursive(self):
        result = glob_files("**/*.py")
        self.assertEqual(result["count"], 2)
        paths = {m["path"] for m in result["matches"]}
        self.assertIn("script.py", paths)
        self.assertIn("sub/helper.py", paths)

    def test_glob_no_matches(self):
        result = glob_files("**/*.rs")
        self.assertEqual(result["count"], 0)

    def test_glob_in_subdirectory(self):
        result = glob_files("*.py", directory="sub")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["matches"][0]["path"], "sub/helper.py")


class HttpRequestTests(TestCase):
    """HTTP requests accept arbitrary domains and preserve request options."""

    @patch("requests.request")
    def test_get_success(self, mock_request):
        mock_request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            json=lambda: {"data": "test"},
        )
        result = http_request("GET", "https://api.github.com/repos/test")
        self.assertEqual(result["status_code"], 200)
        self.assertEqual(result["body"], {"data": "test"})

    def test_unsupported_method_returns_error(self):
        result = http_request("INVALID", "https://example.com")
        self.assertIn("error", result)

    @patch("requests.request")
    def test_arbitrary_domain_is_requested(self, mock_request):
        mock_request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "text/plain"},
            text="OK",
        )
        result = http_request("GET", "https://example.com/test")
        self.assertEqual(result["status_code"], 200)
        mock_request.assert_called_once_with(
            "GET", "https://example.com/test", headers={}, json=None, timeout=10,
        )

    @patch("requests.request")
    def test_custom_port_is_requested(self, mock_request):
        mock_request.return_value = MagicMock(status_code=200, headers={}, text="OK")
        result = http_request("GET", "http://example.com:8080/test")
        self.assertEqual(result["status_code"], 200)
        self.assertEqual(mock_request.call_args.args[1], "http://example.com:8080/test")

    @patch("requests.request")
    def test_http_post_with_body(self, mock_request):
        mock_request.return_value = MagicMock(
            status_code=201,
            headers={"content-type": "application/json"},
            json=lambda: {"id": 1},
        )
        result = http_request(
            "POST",
            "https://api.github.com/repos",
            body={"name": "test"},
        )
        self.assertEqual(result["status_code"], 201)
        mock_request.assert_called_with(
            "POST",
            "https://api.github.com/repos",
            headers={},
            json={"name": "test"},
            timeout=10,
        )

    @patch("requests.request")
    def test_request_timeout(self, mock_request):
        from requests.exceptions import Timeout
        mock_request.side_effect = Timeout("timed out")
        result = http_request("GET", "https://api.github.com/test", timeout=1)
        self.assertIn("error", result)

    @patch("requests.request")
    def test_http_request_with_custom_headers(self, mock_request):
        mock_request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            json=lambda: {"ok": True},
        )
        result = http_request(
            "GET",
            "https://api.github.com/test",
            headers={"Authorization": "Bearer token123"},
        )
        self.assertEqual(result["status_code"], 200)
        mock_request.assert_called_with(
            "GET",
            "https://api.github.com/test",
            headers={"Authorization": "Bearer token123"},
            json=None,
            timeout=10,
        )


class DispatchFileToolTests(_WorkspaceTestBase):
    """dispatch_file_tool() routing and error wrapping."""

    def test_dispatch_routes_to_correct_handler(self):
        result = dispatch_file_tool("shell_exec", {"command": "echo hello"})
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("hello", result["stdout"])

    def test_dispatch_unknown_tool_returns_error(self):
        result = dispatch_file_tool("nonexistent_tool", {})
        self.assertEqual(result["error"], "Unknown tool: nonexistent_tool")

    def test_dispatch_wraps_handler_exception(self):
        result = dispatch_file_tool(
            "file_patch",
            {"path": "missing.txt", "find": "x", "replace": "y"},
        )
        self.assertIn("error", result)

    def test_dispatch_routes_all_known_tools(self):
        for tool_name in [
            "file_read",
            "file_write",
            "file_patch",
            "file_content_search",
            "shell_exec",
            "list_directory",
            "glob_files",
            "http_request",
        ]:
            result = dispatch_file_tool(tool_name, {})
            self.assertIsInstance(result, dict)
            # Each tool returns either a result or an error for empty args

    def test_dispatch_missing_arguments_returns_dict_not_crash(self):
        result = dispatch_file_tool("file_read", {})
        self.assertIsInstance(result, dict)


class SandboxPingViewTests(TestCase):
    """Test SandboxPingView execution with echo PONG."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        from sandbox.models import Sandbox
        User = get_user_model()
        self.client = APIClient()
        self.user = User.objects.create_user(username="pinguser", password="secretpassword")
        self.sandbox = Sandbox.objects.create(
            slug="ping-sandbox",
            display_name="Ping Sandbox",
            user=self.user,
            sandbox_gpu="CPU",
        )

    @patch("sandbox.services.sandbox_session.get_sandbox_manager")
    def test_ping_executes_pong(self, mock_get_manager):
        mock_manager = MagicMock()
        mock_manager.update_activity.return_value = {
            "shutdown_at": None,
            "remaining_seconds": 300,
        }
        mock_get_manager.return_value = mock_manager

        self.client.force_authenticate(user=self.user)
        response = self.client.post(f"/sandbox/sandboxes/{self.sandbox.uuid}/ping/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "success": True,
                "pong": True,
                "shutdown_at": None,
                "remaining_seconds": 300,
            },
        )
        mock_manager.update_activity.assert_called_once_with(str(self.sandbox.uuid))

