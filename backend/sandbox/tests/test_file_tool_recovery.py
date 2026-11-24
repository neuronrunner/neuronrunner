import errno
import os
from pathlib import Path
import signal
import subprocess
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.test import SimpleTestCase

from sandbox.services import file_tools


class FileToolRecoveryTests(SimpleTestCase):
    def test_missing_project_directory_has_actionable_error_and_directory_create_recovers(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            with patch.object(file_tools, "WORKSPACE_ROOT", str(root)):
                result = file_tools.shell_exec("pwd")
                self.assertEqual(result["exit_code"], 1)
                self.assertIn("directory_create", result["stderr"])
                self.assertFalse(root.exists())
                file_tools.directory_create(".")
                self.assertEqual(file_tools.shell_exec("pwd")["stdout"].strip(), str(root))

    def test_absolute_paths_are_not_silently_remapped_to_the_project(self):
        with TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
            with self.assertRaises(file_tools.PathTraversalError):
                file_tools._normalize_path("/workspace/other-project/main.py")
            self.assertEqual(file_tools._normalize_path("main.py"), Path(directory) / "main.py")

    def test_file_and_directory_moves_work_without_rename_or_metadata_operations(self):
        for is_directory in (False, True):
            with self.subTest(is_directory=is_directory), TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
                root = Path(directory)
                source = root / "old"
                if is_directory:
                    (source / "nested").mkdir(parents=True)
                    (source / "nested" / "photo.jpg").write_bytes(b"photo")
                else:
                    source.write_bytes(b"photo")
                with patch("os.rename", side_effect=OSError(errno.ENOSYS, "Function not implemented")), patch("shutil.copystat", side_effect=OSError(errno.ENOSYS, "No metadata")):
                    result = file_tools.file_rename("old", "new")
                self.assertTrue(result["success"])
                self.assertFalse(source.exists())
                target = root / "new" / "nested" / "photo.jpg" if is_directory else root / "new"
                self.assertEqual(target.read_bytes(), b"photo")

    def test_failed_copy_does_not_delete_source(self):
        with TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
            source = Path(directory) / "old"
            source.write_bytes(b"photo")
            with patch("os.rename", side_effect=OSError(errno.ENOSYS, "Function not implemented")), patch("shutil.copyfile", side_effect=OSError("copy failed")):
                self.assertIn("copy failed", file_tools.dispatch_file_tool("file_rename", {"old_path": "old", "new_path": "new"})["error"])
            self.assertEqual(source.read_bytes(), b"photo")

    def test_pkill_does_not_match_the_script_running_the_command(self):
        if not Path("/usr/bin/pkill").exists():
            self.skipTest("pkill is unavailable")
        with TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
            marker = "nr-process-test-" + str(os.getpid())
            server = subprocess.Popen(["bash", "-c", f"exec -a {marker} sleep 10"], start_new_session=True)
            try:
                for stream in (False, True):
                    result = file_tools.shell_exec(f"pkill -f '{marker}' || true; printf survived", timeout=3, on_output=(lambda *args: None) if stream else None)
                    self.assertEqual(result["exit_code"], 0)
                    self.assertEqual(result["stdout"], "survived")
            finally:
                if server.poll() is None:
                    os.killpg(server.pid, signal.SIGKILL)
                server.wait()
