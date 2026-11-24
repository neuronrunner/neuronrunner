"""Self-hosted named runtimes: several local Docker sandboxes per workspace."""
from pathlib import Path
from subprocess import CompletedProcess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation
from chat.views.predict import _setup_conversation
from core.extensions import registry
from sandbox.middleware import SandboxRuntimeMiddleware
from sandbox.models import WorkspaceMembership
from sandbox.services import docker_sandbox
from sandbox.services.docker_sandbox import (
    DEFAULT_RUNTIME_NAME,
    ensure_docker_sandbox,
    get_sandbox_container_name,
    list_workspace_runtimes,
    normalize_runtime_name,
    workspace_id_from_container,
)
from sandbox.services.sandbox_service import SandboxBootstrapService
from sandbox.services.sandbox_session import (
    RuntimeLimitError,
    SandboxSessionManager,
    coerce_runtime_name,
    max_concurrent_runtimes,
    selected_runtime,
    use_runtime,
)

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


def completed(code=0, stdout="", stderr=""):
    return CompletedProcess([], code, stdout, stderr)


class RuntimeNamingTests(SimpleTestCase):
    def test_names_are_validated_and_default_is_implicit(self):
        self.assertEqual(normalize_runtime_name(None), DEFAULT_RUNTIME_NAME)
        self.assertEqual(normalize_runtime_name(""), DEFAULT_RUNTIME_NAME)
        self.assertEqual(normalize_runtime_name(" API "), "api")
        self.assertEqual(normalize_runtime_name("worker-2"), "worker-2")
        for bad in ("-api", "api-", "a b", "a_b", "x" * 25, "../etc", "api;rm"):
            with self.assertRaises(ValueError, msg=bad):
                normalize_runtime_name(bad)

    def test_container_names(self):
        project = SimpleNamespace(workspace_id="ws1", user_id="u1")
        self.assertEqual(get_sandbox_container_name(project), "nr-sandbox-workspace-ws1")
        self.assertEqual(get_sandbox_container_name(project, "default"), "nr-sandbox-workspace-ws1")
        self.assertEqual(get_sandbox_container_name(project, "api"), "nr-sandbox-workspace-ws1-rt-api")
        self.assertEqual(workspace_id_from_container("nr-sandbox-workspace-ws1-rt-api"), "ws1")
        self.assertEqual(workspace_id_from_container("nr-sandbox-workspace-ws1"), "ws1")
        self.assertIsNone(workspace_id_from_container("postgres"))

    @override_settings(SANDBOX_PROVIDER="docker")
    def test_coerce_ignores_default_and_invalid_values(self):
        self.assertIsNone(coerce_runtime_name(""))
        self.assertIsNone(coerce_runtime_name("default"))
        self.assertIsNone(coerce_runtime_name("3fa85f64-5717-4562-b3fc-2c963f66afa6"))
        self.assertEqual(coerce_runtime_name("api"), "api")

    @override_settings(SANDBOX_PROVIDER="remote")
    def test_remote_provider_has_no_named_runtimes(self):
        self.assertIsNone(coerce_runtime_name("api"))


class NamedDockerContainerTests(SimpleTestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.project = SimpleNamespace(uuid="project", workspace_id="team", user_id="owner", slug="example", sandbox_cpu=0.5, sandbox_memory=2048)
        for target in (
            patch.object(docker_sandbox, "get_shared_workspace_root", return_value=self.root),
            patch.object(docker_sandbox, "_own_container_mounts", return_value=[]),
            patch.object(docker_sandbox, "resolve_sandbox_image", return_value="python:3.11-slim"),
        ):
            target.start()
            self.addCleanup(target.stop)

    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_named_runtime_gets_its_own_container_on_the_shared_mount(self, run):
        run.side_effect = [completed(1, stderr="Error: No such object"), completed()]
        self.assertEqual(ensure_docker_sandbox(self.project, "api"), "nr-sandbox-workspace-team-rt-api")
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[1], "run")
        self.assertIn("nr-sandbox-workspace-team-rt-api", cmd)
        self.assertEqual(cmd[cmd.index("--hostname") + 1], "example-api")
        self.assertIn(f"{self.root}:/workspace", cmd)
        self.assertIn("neuronrunner.runtime=api", cmd)
        self.assertIn("neuronrunner.workspace=nr-sandbox-workspace-team", cmd)

    @patch("sandbox.services.docker_sandbox.subprocess.run")
    def test_listing_puts_default_first_and_maps_states(self, run):
        run.return_value = completed(stdout=(
            "nr-sandbox-workspace-team-rt-worker\texited\t2026-11-24\n"
            "nr-sandbox-workspace-team-rt-api\trunning\t2026-11-24\n"
            "nr-sandbox-workspace-teammate\trunning\t2026-11-24\n"
        ))
        items = list_workspace_runtimes(self.project)
        self.assertEqual([item["name"] for item in items], ["default", "api", "worker"])
        self.assertEqual([item["status"] for item in items], ["not_created", "running", "stopped"])
        self.assertTrue(items[0]["is_default"])


@override_settings(CACHES=LOCMEM, SANDBOX_PROVIDER="docker", DOCKER_SANDBOX_MAX_CONCURRENT=3)
class NamedRuntimeManagerTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="rt-owner", email="rt-owner@example.com", password="test123")
        self.project = SandboxBootstrapService.ensure_personal_filesystem(self.user)

    def fake_runtime(self, name):
        runtime = MagicMock()
        runtime.runtime_name = name
        runtime.container_name = runtime.object_id = get_sandbox_container_name(self.project, name)
        runtime.poll.return_value = None
        return runtime

    def test_two_named_runtimes_run_side_by_side_without_touching_the_default(self):
        manager = SandboxSessionManager()
        created = {}

        def build(project, runtime_name=None):
            created[runtime_name] = self.fake_runtime(runtime_name)
            return created[runtime_name]

        with patch("sandbox.services.sandbox_session.LocalDockerSandbox", side_effect=build), \
                patch("sandbox.services.sandbox_session.count_running_runtimes", return_value=0), \
                patch.object(manager, "_create_sandbox") as create_default:
            api = manager.get_or_create(self.project, runtime="api")
            worker = manager.get_or_create(self.project, runtime="worker")
            self.assertIs(manager.get_or_create(self.project, runtime="api"), api)
            create_default.assert_not_called()

        self.assertIsNot(api, worker)
        self.assertEqual(set(created), {"api", "worker"})
        self.project.refresh_from_db()
        self.assertEqual(self.project.sandbox_object_id, "")

    def test_request_selection_routes_unqualified_calls(self):
        manager = SandboxSessionManager()
        with patch("sandbox.services.sandbox_session.LocalDockerSandbox", side_effect=lambda p, runtime_name=None: self.fake_runtime(runtime_name)) as build, \
                patch("sandbox.services.sandbox_session.count_running_runtimes", return_value=0):
            with use_runtime("api"):
                self.assertEqual(selected_runtime(), "api")
                runtime = manager.get_or_create(self.project)
            self.assertIsNone(selected_runtime())
        self.assertEqual(runtime.runtime_name, "api")
        build.assert_called_once()

    def test_explicit_default_overrides_the_request_selection(self):
        manager = SandboxSessionManager()
        default_runtime = self.fake_runtime(None)

        def create(project, region=None):
            project.sandbox_object_id = default_runtime.object_id
            return default_runtime

        with patch.object(manager, "_create_sandbox", side_effect=create), use_runtime("api"):
            self.assertIs(manager.get_or_create(self.project, runtime=""), default_runtime)

    def test_limit_blocks_launching_another_runtime(self):
        manager = SandboxSessionManager()
        with patch("sandbox.services.sandbox_session.count_running_runtimes", return_value=3) as count, \
                patch("sandbox.services.sandbox_session.LocalDockerSandbox") as build:
            with self.assertRaisesRegex(RuntimeLimitError, "maximum is 3"):
                manager.get_or_create(self.project, runtime="api")
        build.assert_not_called()
        count.assert_called_once_with(self.project, exclude="api")

    @override_settings(DOCKER_SANDBOX_MAX_CONCURRENT=0)
    def test_zero_limit_means_unlimited(self):
        self.assertIsNone(max_concurrent_runtimes(self.project.workspace))
        self.assertIsNone(registry.quota.resolve_plan_policy(self.project.workspace)["max_concurrent_vms"])

    def test_stop_and_remove_named_runtime(self):
        manager = SandboxSessionManager()
        with patch("sandbox.services.sandbox_session.stop_docker_runtime") as stop, \
                patch("sandbox.services.sandbox_session.remove_docker_runtime") as remove, \
                patch.object(manager, "close_session_immediately") as close_default:
            manager.stop_runtime(self.project, "api")
            manager.stop_runtime(self.project, "api", remove=True)
            manager.stop_runtime(self.project, "default")
        stop.assert_called_once_with(self.project, "api")
        remove.assert_called_once_with(self.project, "api")
        close_default.assert_called_once_with(self.project)

    def test_idle_named_runtime_is_stopped(self):
        manager = SandboxSessionManager()
        container = get_sandbox_container_name(self.project, "api")
        with patch("sandbox.services.sandbox_session.list_running_named_runtimes", return_value=[(container, "api")]), \
                patch("sandbox.services.sandbox_session.get_cache", return_value=0.0), \
                patch.object(manager, "stop_runtime") as stop:
            manager._cleanup_idle_named()
        stop.assert_called_once_with(self.project, "api")


@override_settings(CACHES=LOCMEM, SANDBOX_PROVIDER="docker")
class RuntimeSelectionPlumbingTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="rt-chat", email="rt-chat@example.com", password="test123")
        self.project = SandboxBootstrapService.ensure_personal_filesystem(self.user)

    def test_middleware_applies_header_only_during_the_view(self):
        seen = []
        middleware = SandboxRuntimeMiddleware(lambda request: seen.append(selected_runtime()) or "ok")
        middleware(RequestFactory().get("/", HTTP_X_SANDBOX_RUNTIME="api"))
        middleware(RequestFactory().get("/"))
        self.assertEqual(seen, ["api", None])
        self.assertIsNone(selected_runtime())

    def test_chat_request_binds_conversation_to_selected_runtime(self):
        request = SimpleNamespace(user=self.user, META={}, data={"project_uuid": str(self.project.uuid), "vm_uuid": "api"})
        conversation, _ = _setup_conversation(request)
        self.assertEqual(Conversation.objects.get(pk=conversation.pk).runtime_name, "api")

        request.data = {"conversation_uuid": str(conversation.uuid), "project_uuid": str(self.project.uuid), "vm_uuid": "default"}
        conversation, _ = _setup_conversation(request)
        self.assertEqual(Conversation.objects.get(pk=conversation.pk).runtime_name, "")

    def test_conversation_tools_run_in_its_runtime(self):
        conversation = Conversation.objects.create(user=self.user, runtime_name="worker")
        self.project.conversations.add(conversation)
        with patch("sandbox.services.sandbox_session.SandboxSessionManager.execute_tool", return_value={"ok": True}) as execute:
            execute_builtin_tool(self.user, "list_directory", {"path": ".", "_runtime": "injected"}, conversation=conversation)
        self.assertEqual(execute.call_args.kwargs.get("runtime"), "worker")


@override_settings(CACHES=LOCMEM, SANDBOX_PROVIDER="docker", DOCKER_SANDBOX_MAX_CONCURRENT=3)
class RuntimeApiTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.owner = User.objects.create_user(username="rt-api-owner", email="rt-api-owner@example.com", password="test123")
        self.member = User.objects.create_user(username="rt-api-member", email="rt-api-member@example.com", password="test123")
        self.stranger = User.objects.create_user(username="rt-api-stranger", email="rt-api-stranger@example.com", password="test123")
        self.project = SandboxBootstrapService.ensure_personal_filesystem(self.owner)
        self.workspace = self.project.workspace
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.member, role="member")
        self.client = APIClient()
        self.client.force_authenticate(self.member)
        self.url = f"/sandbox/workspaces/{self.workspace.pk}/runtimes/"
        self.items = [
            {"uuid": "default", "name": "default", "container": "c", "status": "running", "created_at": None, "is_default": True},
        ]
        listing = patch("sandbox.services.sandbox_session.list_workspace_runtimes", side_effect=lambda project: [dict(i) for i in self.items])
        listing.start()
        self.addCleanup(listing.stop)

    def test_list(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["max_concurrent"], 3)
        self.assertEqual(response.data["running"], 1)
        self.assertEqual(response.data["items"][0]["name"], "default")

    def test_launch_named_runtime(self):
        def start(project, name):
            self.items.append({"uuid": name, "name": name, "container": "c2", "status": "running", "created_at": None, "is_default": False})

        with patch("sandbox.services.sandbox_session.SandboxSessionManager.start_runtime", side_effect=start) as launch:
            response = self.client.post(self.url, {"name": "API"}, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(launch.call_args.args[1], "api")
        self.assertEqual(response.data["runtime"]["name"], "api")
        self.assertEqual(response.data["running"], 2)

    def test_launch_validation_and_limit(self):
        self.assertEqual(self.client.post(self.url, {"name": "bad name"}, format="json").status_code, 400)
        with patch("sandbox.services.sandbox_session.SandboxSessionManager.start_runtime", side_effect=RuntimeLimitError("limit")):
            response = self.client.post(self.url, {"name": "api"}, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "runtime_limit_reached")

    def test_stop_and_remove(self):
        with patch("sandbox.services.sandbox_session.SandboxSessionManager.stop_runtime") as stop:
            self.assertEqual(self.client.post(f"{self.url}api/stop/").status_code, 200)
            self.assertEqual(self.client.delete(f"{self.url}api/").status_code, 200)
        self.assertEqual(stop.call_args_list[0].kwargs, {"remove": False})
        self.assertEqual(stop.call_args_list[1].kwargs, {"remove": True})
        response = self.client.delete(f"{self.url}default/")
        self.assertEqual(response.status_code, 400)

    def test_non_members_and_remote_providers_get_404(self):
        self.client.force_authenticate(self.stranger)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.client.force_authenticate(self.member)
        with self.settings(SANDBOX_PROVIDER="remote"):
            self.assertEqual(self.client.get(self.url).status_code, 404)
