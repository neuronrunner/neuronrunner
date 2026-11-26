"""Tests for repo-backed Environments, scoped secrets, and compressed state/deps bootstrap."""
from __future__ import annotations

import io
import os
import subprocess
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sandbox.models import Sandbox, Workspace, WorkspaceMembership, WorkspaceVMSecret
from sandbox.services import environment_bootstrap
from sandbox.services.vm_secrets import resolve_workspace_secrets

User = get_user_model()


class _LocalProcess:
    def __init__(self, completed: subprocess.CompletedProcess):
        self.returncode = completed.returncode
        self.stdout = io.StringIO(completed.stdout or "")
        self.stderr = io.StringIO(completed.stderr or "")

    def wait(self, timeout=None):
        return self.returncode


class _LocalRuntime:
    """In-process runtime executing commands directly with subprocess for deterministic tests."""

    def exec(self, *argv, timeout=120):
        completed = subprocess.run(
            [str(a) for a in argv],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return _LocalProcess(completed)


@override_settings(SANDBOX_PROVIDER="docker")
class EnvironmentModelAndAPITests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="envtester", email="env@example.com", password="pw")
        self.workspace = Workspace.objects.create(name="Env WS", slug="env-ws", owner=self.user)
        WorkspaceMembership.objects.create(
            workspace=self.workspace,
            user=self.user,
            role=WorkspaceMembership.ROLE_OWNER,
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    @patch("sandbox.views.initialize_project_repository")
    def test_lazy_environment_create_skips_vm_initialization(self, mock_init):
        res = self.client.post(
            "/sandbox/sandboxes/",
            {
                "workspace_uuid": str(self.workspace.uuid),
                "repo_full_name": "neuronrunner/demo-app",
                "default_branch": "main",
                "working_subdir": "frontend",
                "setup_script": "npm ci",
                "maintenance_script": "npm ci --prefer-offline",
                "usage_guide": "Always run vitest before committing.",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.data)
        mock_init.assert_not_called()
        data = res.data
        self.assertEqual(data["display_name"], "demo-app")
        self.assertEqual(data["slug"], "demo-app")
        self.assertEqual(data["filesystem_path"], "/workspace/demo-app")
        self.assertEqual(data["repo_full_name"], "neuronrunner/demo-app")
        self.assertEqual(data["repo_url"], "https://github.com/neuronrunner/demo-app.git")
        self.assertEqual(data["default_branch"], "main")
        self.assertEqual(data["working_subdir"], "frontend")
        self.assertEqual(data["setup_script"], "npm ci")
        self.assertEqual(data["setup_status"], "idle")

    def test_environment_secrets_override_workspace_globals(self):
        env_a = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="env-a",
            display_name="Env A",
            filesystem_path="/workspace/env-a",
        )
        env_b = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="env-b",
            display_name="Env B",
            filesystem_path="/workspace/env-b",
        )

        # Create workspace global secret + env_a override + env_b distinct value for same key
        with patch("sandbox.vm_secret_views.sync_secrets_to_container", return_value=0):
            r1 = self.client.post(
                f"/sandbox/workspaces/{self.workspace.uuid}/vm-secrets/",
                {"key": "DATABASE_URL", "value": "postgres://global"},
                format="json",
            )
            self.assertEqual(r1.status_code, 201, r1.data)

            r2 = self.client.post(
                f"/sandbox/workspaces/{self.workspace.uuid}/vm-secrets/",
                {"key": "DATABASE_URL", "value": "postgres://env-a", "sandbox_uuid": str(env_a.uuid)},
                format="json",
            )
            self.assertEqual(r2.status_code, 201, r2.data)
            self.assertEqual(r2.data["scope"], "environment")

            r3 = self.client.post(
                f"/sandbox/workspaces/{self.workspace.uuid}/vm-secrets/",
                {"key": "DATABASE_URL", "value": "postgres://env-b", "sandbox_uuid": str(env_b.uuid)},
                format="json",
            )
            self.assertEqual(r3.status_code, 201, r3.data)

            # Duplicate in same environment is rejected
            r_dup = self.client.post(
                f"/sandbox/workspaces/{self.workspace.uuid}/vm-secrets/",
                {"key": "DATABASE_URL", "value": "postgres://dup", "sandbox_uuid": str(env_a.uuid)},
                format="json",
            )
            self.assertEqual(r_dup.status_code, 400)

        self.assertEqual(resolve_workspace_secrets(self.workspace), {"DATABASE_URL": "postgres://global"})
        self.assertEqual(resolve_workspace_secrets(self.workspace, sandbox=env_a), {"DATABASE_URL": "postgres://env-a"})
        self.assertEqual(resolve_workspace_secrets(self.workspace, sandbox=env_b), {"DATABASE_URL": "postgres://env-b"})

        # GET with sandbox_uuid returns environment secrets + inherited workspace secrets marked overridden
        list_res = self.client.get(
            f"/sandbox/workspaces/{self.workspace.uuid}/vm-secrets/?sandbox_uuid={env_a.uuid}"
        )
        self.assertEqual(list_res.status_code, 200)
        self.assertEqual(len(list_res.data["secrets"]), 1)
        self.assertEqual(list_res.data["secrets"][0]["scope"], "environment")
        self.assertEqual(len(list_res.data["inherited_secrets"]), 1)
        self.assertTrue(list_res.data["inherited_secrets"][0]["overridden"])

        # Global GET excludes environment-scoped secrets
        global_res = self.client.get(f"/sandbox/workspaces/{self.workspace.uuid}/vm-secrets/")
        self.assertEqual(global_res.status_code, 200)
        self.assertEqual(len(global_res.data["secrets"]), 1)
        self.assertEqual(global_res.data["secrets"][0]["scope"], "workspace")

    def test_state_checkpoint_and_deps_archive_roundtrip_with_ttl_pruning(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            origin = tmp_path / "origin.git"
            seed = tmp_path / "seed"
            store = tmp_path / "nr-store"
            ws_dir = tmp_path / "ws"
            store.mkdir()
            ws_dir.mkdir()

            subprocess.run(["git", "init", "--bare", str(origin)], check=True, capture_output=True)
            subprocess.run(["git", "init", "-b", "main", str(seed)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(seed), "config", "user.email", "t@example.com"], check=True)
            subprocess.run(["git", "-C", str(seed), "config", "user.name", "Test"], check=True)
            (seed / "package-lock.json").write_text('{"name":"demo","lockfileVersion":3}\n', encoding="utf-8")
            (seed / "app.txt").write_text("v1\n", encoding="utf-8")
            (seed / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(seed), "add", "."], check=True)
            subprocess.run(["git", "-C", str(seed), "commit", "-m", "init"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(seed), "remote", "add", "origin", str(origin)], check=True)
            subprocess.run(["git", "-C", str(seed), "push", "-u", "origin", "main"], check=True, capture_output=True)

            env_dir = ws_dir / "demo"
            sandbox = Sandbox.objects.create(
                user=self.user,
                workspace=self.workspace,
                slug="demo",
                display_name="Demo",
                filesystem_path=str(env_dir),
                repo_url=str(origin),
                default_branch="main",
                setup_script="mkdir -p node_modules/pkg && echo ok > node_modules/pkg/index.js",
            )
            runtime = _LocalRuntime()

            # Plant an expired >7d deps file to verify automatic pruning
            old_dep = store / "deps" / "old-env-deadbeef.tar.zst"
            old_dep.parent.mkdir(parents=True, exist_ok=True)
            old_dep.write_bytes(b"stale")
            stale_ts = time.time() - (8 * 24 * 3600)
            os.utime(old_dep, (stale_ts, stale_ts))

            with patch.object(environment_bootstrap, "STORE_ROOT", str(store)):
                # 1. Initial bootstrap clones repo, runs setup_script, and caches deps as tar.zst
                r1 = environment_bootstrap.ensure_environment_ready(sandbox, runtime, user=self.user)
                self.assertTrue(r1["ready"], r1)
                self.assertTrue(r1["cloned"])
                self.assertTrue(r1["setup_ran"])
                self.assertTrue((env_dir / "node_modules/pkg/index.js").is_file())
                self.assertEqual(sandbox.setup_status, Sandbox.SETUP_STATUS_READY)

                # 2. Make an unpushed commit + dirty edit + untracked file, then save state
                subprocess.run(["git", "-C", str(env_dir), "config", "user.email", "t@example.com"], check=True)
                subprocess.run(["git", "-C", str(env_dir), "config", "user.name", "Test"], check=True)
                (env_dir / "committed.txt").write_text("local commit\n", encoding="utf-8")
                subprocess.run(["git", "-C", str(env_dir), "add", "committed.txt"], check=True)
                subprocess.run(["git", "-C", str(env_dir), "commit", "-m", "local work"], check=True, capture_output=True)
                (env_dir / "app.txt").write_text("v1-edited\n", encoding="utf-8")
                (env_dir / "untracked.txt").write_text("new file\n", encoding="utf-8")

                saved = environment_bootstrap.save_environment_state(sandbox, runtime)
                self.assertTrue(saved.get("saved"), saved)
                self.assertEqual(saved.get("pruned_deps"), 1)
                self.assertFalse(old_dep.exists())

                # Second save with no new changes is a no-op
                saved2 = environment_bootstrap.save_environment_state(sandbox, runtime)
                self.assertTrue(saved2.get("unchanged"), saved2)

                # 3. Simulate fresh stateless container: wipe env_dir and boot marker
                import shutil
                shutil.rmtree(env_dir)
                Path(f"/tmp/.nr-state-restored-{sandbox.uuid}").unlink(missing_ok=True)

                r2 = environment_bootstrap.ensure_environment_ready(sandbox, runtime, user=self.user)
                self.assertTrue(r2["ready"], r2)
                self.assertTrue(r2["state_restored"])
                self.assertEqual(r2["deps_restored"], "archive")
                self.assertFalse(r2["setup_ran"])
                self.assertEqual((env_dir / "committed.txt").read_text("utf-8"), "local commit\n")
                self.assertEqual((env_dir / "app.txt").read_text("utf-8"), "v1-edited\n")
                self.assertEqual((env_dir / "untracked.txt").read_text("utf-8"), "new file\n")
                self.assertEqual((env_dir / "node_modules/pkg/index.js").read_text("utf-8").strip(), "ok")

    def test_github_clone_url_reads_extra_data_access_token_without_workspace_kwarg(self):
        from types import SimpleNamespace
        sandbox = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="priv-app",
            display_name="Priv App",
            filesystem_path="/workspace/priv-app",
            repo_full_name="org/priv-app",
        )
        fake_social = SimpleNamespace(extra_data={"access_token": "gho_secret123"})
        with patch.object(environment_bootstrap, "get_github_connection", side_effect=lambda user: fake_social) as mock_conn:
            auth_url, clean_url = environment_bootstrap._github_clone_url(sandbox, user=self.user)
        mock_conn.assert_called_once_with(self.user)
        self.assertEqual(clean_url, "https://github.com/org/priv-app.git")
        self.assertEqual(auth_url, "https://x-access-token:gho_secret123@github.com/org/priv-app.git")

    def test_setup_script_generating_lockfile_updates_lock_hash_and_caches_deps(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            store = tmp_path / "nr-store"
            env_dir = tmp_path / "ws" / "genlock"
            store.mkdir()
            env_dir.mkdir(parents=True)
            (env_dir / "package.json").write_text('{"name":"genlock"}\n', encoding="utf-8")

            sandbox = Sandbox.objects.create(
                user=self.user,
                workspace=self.workspace,
                slug="genlock",
                display_name="Genlock",
                filesystem_path=str(env_dir),
                setup_script=(
                    "echo '{\"lockfileVersion\":3}' > package-lock.json && "
                    "mkdir -p node_modules/x && echo 1 > node_modules/x/a.js"
                ),
            )
            runtime = _LocalRuntime()
            with patch.object(environment_bootstrap, "STORE_ROOT", str(store)):
                r1 = environment_bootstrap.ensure_environment_ready(sandbox, runtime, user=self.user)
                self.assertTrue(r1["ready"], r1)
                self.assertTrue(r1["deps_cache"]["cached"], r1)
                self.assertTrue(sandbox.deps_lock_hash)
                # Wipe node_modules and re-run: should restore archive using the post-setup lock_hash!
                import shutil
                shutil.rmtree(env_dir / "node_modules")
                r2 = environment_bootstrap.ensure_environment_ready(sandbox, runtime, user=self.user)
                self.assertEqual(r2["deps_restored"], "archive")
                self.assertFalse(r2["setup_ran"])
                self.assertTrue((env_dir / "node_modules/x/a.js").is_file())

    def test_state_checkpoint_skips_oversized_files_and_preserves_source_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            store = tmp_path / "nr-store"
            env_dir = tmp_path / "ws" / "bigguard"
            store.mkdir()
            env_dir.mkdir(parents=True)
            subprocess.run(["git", "init", "-b", "main", str(env_dir)], check=True, capture_output=True)
            (env_dir / "small.py").write_text("print('keep me')\n", encoding="utf-8")
            (env_dir / "huge.bin").write_bytes(b"X" * 2048)

            sandbox = Sandbox.objects.create(
                user=self.user,
                workspace=self.workspace,
                slug="bigguard",
                display_name="Big Guard",
                filesystem_path=str(env_dir),
            )
            runtime = _LocalRuntime()
            with patch.object(environment_bootstrap, "STORE_ROOT", str(store)), \
                    patch.object(environment_bootstrap, "MAX_STATE_FILE_BYTES", 1024), \
                    patch.object(environment_bootstrap, "MAX_STATE_TOTAL_BYTES", 1024 * 1024):
                res = environment_bootstrap.save_environment_state(sandbox, runtime)
            self.assertTrue(res.get("saved"), res)
            self.assertEqual(res.get("skipped_large_files"), ["huge.bin"])
            self.assertLess(res.get("bytes", 999999), 1500)
