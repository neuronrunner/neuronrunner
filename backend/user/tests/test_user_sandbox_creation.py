from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sandbox.models import Sandbox, Workspace, WorkspaceMembership
from sandbox.services.sandbox_service import SandboxBootstrapService

User = get_user_model()


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class UserSandboxCreationTest(TestCase):
    def create_user(self, username):
        return User.objects.create_user(username=username, email=f"{username}@example.com", password="testpassword123")

    def test_signup_creates_workspace_without_a_default_project(self):
        user = self.create_user("testpilot")
        self.assertFalse(Sandbox.objects.filter(user=user).exists())
        workspace = Workspace.objects.get(owner=user, storage_key=f"user-{user.pk}")
        self.assertEqual(workspace.name, "testpilot's workspace")
        self.assertTrue(WorkspaceMembership.objects.filter(workspace=workspace, user=user, role="owner").exists())

    def test_creating_another_workspace_does_not_create_a_project(self):
        user = self.create_user("teamowner")
        client = APIClient()
        client.force_authenticate(user=user)
        response = client.post("/sandbox/workspaces/", {"name": "Empty team"}, format="json")
        self.assertEqual(response.status_code, 201)
        workspace = Workspace.objects.get(uuid=response.json()["uuid"])
        self.assertFalse(workspace.projects.exists())
        for _ in range(2):
            listed = client.get("/sandbox/sandbox-tools/list/", {"workspace_uuid": str(workspace.uuid)})
            self.assertEqual(listed.status_code, 200)
            self.assertEqual(listed.json()["sandboxes"], [])
        self.assertEqual(workspace.projects.count(), 1)
        self.assertEqual(workspace.projects.get().filesystem_path, "/workspace")

    def test_user_save_does_not_create_a_project(self):
        user = self.create_user("saver")
        user.first_name = "UpdatedName"
        user.save()
        self.assertFalse(Sandbox.objects.filter(user=user).exists())
        self.assertEqual(Workspace.objects.filter(owner=user).count(), 1)

    def test_filesystem_is_created_on_demand_and_is_idempotent(self):
        user = self.create_user("idempotent")
        first = SandboxBootstrapService.ensure_personal_filesystem(user)
        second = SandboxBootstrapService.ensure_personal_filesystem(user)
        self.assertEqual(first.uuid, second.uuid)
        self.assertEqual(first.slug, "files")
        self.assertEqual(first.display_name, "Files")
        self.assertEqual(first.filesystem_path, "/workspace")
        self.assertEqual(first.sandbox_gpu, "CPU")
        self.assertEqual(first.sandbox_cpu, 0.5)
        self.assertEqual(first.sandbox_memory, 2048)
        self.assertEqual(first.r2_workspace_prefix, f"sandboxes/workspace-user-{user.pk}/")
        self.assertFalse(first.is_favorite)
        self.assertEqual(Sandbox.objects.filter(user=user).count(), 1)
        self.assertFalse(Sandbox.objects.filter(user=user).exclude(filesystem_path="/workspace").exists())

    def test_new_users_have_separate_empty_workspaces(self):
        first = self.create_user("user_one")
        second = self.create_user("user_two")
        self.assertFalse(Sandbox.objects.filter(user__in=[first, second]).exists())
        self.assertNotEqual(Workspace.objects.get(owner=first).uuid, Workspace.objects.get(owner=second).uuid)

    def test_opening_files_creates_only_a_hidden_filesystem_handle(self):
        user = self.create_user("filesuser")
        client = APIClient()
        client.force_authenticate(user=user)
        response = client.get("/sandbox/sandbox-tools/list/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sandboxes"], [])
        self.assertEqual(response.json()["workspace_sandbox"]["slug"], "files")
        self.assertEqual(response.json()["workspace_sandbox"]["filesystem_path"], "/workspace")
        self.assertEqual(Sandbox.objects.filter(user=user).count(), 1)
        self.assertEqual(client.get("/sandbox/sandboxes/").json(), [])

    def test_sandbox_ping_updates_activity(self):
        user = self.create_user("pingtester")
        filesystem = SandboxBootstrapService.ensure_personal_filesystem(user)
        filesystem.sandbox_object_id = "test-runtime"
        filesystem.save(update_fields=["sandbox_object_id"])
        client = APIClient()
        client.force_authenticate(user=user)
        response = client.post(f"/sandbox/sandboxes/{filesystem.uuid}/ping/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        self.assertTrue(response.json()["pong"])
        self.assertGreater(response.json()["remaining_seconds"], 0)

    def test_registration_endpoint_does_not_create_a_default_project(self):
        from authentication.models import OTP

        OTP.objects.create(email="new-signup@example.com", otp="123456")
        client = APIClient()
        response = client.post("/auth/register/", {"username": "new_signup", "email": "new-signup@example.com", "password": "StrongTestPassword123!", "otp": "123456"}, format="json")
        self.assertEqual(response.status_code, 201)
        user = User.objects.get(username="new_signup")
        self.assertEqual(Workspace.objects.filter(owner=user).count(), 1)
        self.assertFalse(Sandbox.objects.filter(user=user).exists())
