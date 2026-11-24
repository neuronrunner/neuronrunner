from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from sandbox.services import docker_sandbox
from sandbox.services.docker_sandbox import DockerSandboxError, ensure_docker_sandbox, to_docker_host_path


class DockerSandboxTests(SimpleTestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.project = SimpleNamespace(uuid="project", workspace_id="team", user_id="owner", slug="example", sandbox_cpu=0.5, sandbox_memory=2048)
        for name in ("get_shared_workspace_root",):
            target = patch(f"sandbox.services.docker_sandbox.{name}", return_value=self.root)
            target.start()
            self.addCleanup(target.stop)
        # Never inspect the test process's own container mounts.
        mounts = patch.object(docker_sandbox, "_own_container_mounts", return_value=[])
        mounts.start()
        self.addCleanup(mounts.stop)

    def result(self, code=0, stdout="", stderr=""):
        return CompletedProcess([], code, stdout, stderr)

    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_wsl_integration_error_stops_without_trying_to_spawn(self, run):
        run.return_value = self.result(1, stderr="The command 'docker' could not be found in this WSL 2 distro. Enable WSL integration in Docker Desktop.")
        with self.assertRaisesRegex(DockerSandboxError, "WSL integration"):
            ensure_docker_sandbox(self.project)
        self.assertEqual(run.call_count, 1)

    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_unavailable_daemon_is_not_treated_as_a_missing_container(self, run):
        run.return_value = self.result(1, stderr="Cannot connect to the Docker daemon at unix:///var/run/docker.sock")
        with self.assertRaisesRegex(DockerSandboxError, "Cannot connect to the Docker daemon"):
            ensure_docker_sandbox(self.project)
        self.assertEqual(run.call_count, 1)

    @patch("sandbox.services.docker_sandbox.resolve_sandbox_image", return_value="python:3.11-slim")
    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_real_startup_error_is_visible(self, run, _mock_image):
        run.side_effect = [self.result(1, stderr="Error: No such object: nr-sandbox-workspace-team"), self.result(1, stderr=("Pulling image layer...\n" * 150) + "invalid mount config: bind source path does not exist")]
        with self.assertRaisesRegex(DockerSandboxError, "bind source path does not exist"):
            ensure_docker_sandbox(self.project)
        self.assertEqual(run.call_args.args[0][1], "run")
        self.assertTrue(run.call_args.kwargs["capture_output"])
        self.assertEqual(run.call_args.kwargs["timeout"], 600)

    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_stopped_container_is_reused_without_deleting_or_creating(self, run):
        run.side_effect = [self.result(stdout="false\n"), self.result(stdout=f"{self.root}\n"), self.result(), self.result()]
        self.assertEqual(ensure_docker_sandbox(self.project), "nr-sandbox-workspace-team")
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ["inspect", "inspect", "update", "start"])

    @patch("sandbox.services.docker_sandbox.resolve_sandbox_image", return_value="python:3.11-slim")
    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_stopped_container_with_stale_mount_is_recreated(self, run, _mock_image):
        run.side_effect = [self.result(stdout="false\n"), self.result(stdout="/somewhere/else\n"), self.result(), self.result()]
        self.assertEqual(ensure_docker_sandbox(self.project), "nr-sandbox-workspace-team")
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ["inspect", "inspect", "rm", "run"])
        self.assertIn(f"{self.root}:/workspace", run.call_args.args[0])

    @override_settings(LOCAL_WORKSPACE_ROOT=Path("/srv/workspaces"), DOCKER_SANDBOX_HOST_WORKSPACE_ROOT="/host/workspaces")
    def test_host_path_translation_accepts_path_settings(self):
        self.assertEqual(to_docker_host_path("/srv/workspaces/team"), "/host/workspaces/team")
        self.assertEqual(to_docker_host_path("/elsewhere/team"), "/elsewhere/team")

    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_running_container_is_reused(self, run):
        run.return_value = self.result(stdout="true\n")
        ensure_docker_sandbox(self.project)
        self.assertEqual(run.call_count, 1)

    @patch("sandbox.services.docker_sandbox.subprocess.run", side_effect=FileNotFoundError)
    def test_missing_cli_has_actionable_error(self, run):
        with self.assertRaisesRegex(DockerSandboxError, "Docker is not installed"):
            ensure_docker_sandbox(self.project)

    @patch("sandbox.services.docker_sandbox.subprocess.run", side_effect=TimeoutExpired("docker", 120))
    def test_unresponsive_daemon_has_actionable_error(self, run):
        with self.assertRaisesRegex(DockerSandboxError, "inspect.*timed out after 120 seconds"):
            ensure_docker_sandbox(self.project)
