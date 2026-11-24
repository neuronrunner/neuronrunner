import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from django.test import SimpleTestCase, override_settings

from sandbox.services.git_service import MAX_DIFF_BYTES, SandboxGitService


class GitDiffBoundsTests(SimpleTestCase):
    def test_run_limited_truncates_large_output(self):
        with TemporaryDirectory() as tmp:
            output, truncated = SandboxGitService._run_limited(
                ["python3", "-c", "print('x' * 100000)"], Path(tmp), 1000,
            )
        self.assertTrue(truncated)
        self.assertLessEqual(len(output), 1000)

    def test_write_git_excludes_adds_heavy_directories(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git" / "info").mkdir(parents=True)
            SandboxGitService._write_git_excludes(root)
            text = (root / ".git" / "info" / "exclude").read_text(encoding="utf-8")
        self.assertIn("node_modules/", text)
        self.assertIn(".venv/", text)

    def test_get_diff_skips_raw_diff_for_oversized_changes(self):
        with TemporaryDirectory() as tmp:
            with override_settings(LOCAL_WORKSPACE_ROOT=tmp):
                project = SimpleNamespace(
                    workspace=SimpleNamespace(storage_key="test-workspace"),
                    filesystem_path="/workspace/project",
                    slug="project",
                    uuid="project-uuid",
                )
                ws_dir = SandboxGitService.get_workspace_dir(project)
                ws_dir.mkdir(parents=True)
                subprocess.run(["git", "init"], cwd=ws_dir, check=True, capture_output=True)
                subprocess.run(["git", "config", "user.name", "Test"], cwd=ws_dir, check=True)
                subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=ws_dir, check=True)
                (ws_dir / "base.txt").write_text("base\n", encoding="utf-8")
                subprocess.run(["git", "add", "-A"], cwd=ws_dir, check=True)
                subprocess.run(["git", "commit", "-m", "base"], cwd=ws_dir, check=True, capture_output=True)

                (ws_dir / "huge.txt").write_text("x\n" * 60_000, encoding="utf-8")
                result = SandboxGitService.get_diff(project)

        self.assertTrue(result["has_changes"])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["raw_diff"], "")
        self.assertLessEqual(len(result["files"]), 1)
