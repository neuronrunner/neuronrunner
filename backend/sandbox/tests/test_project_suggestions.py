from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient
from sandbox.models import Sandbox, Workspace
from sandbox.serializers import SandboxSerializer
from sandbox.views import _init_project_suggestions_on_create, SandboxSuggestionsView

User = get_user_model()


class ProjectSuggestionsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="testuser", password="password123")
        self.workspace = Workspace.objects.create(name="Test Workspace", owner=self.user)
        from sandbox.models import WorkspaceMembership
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.user, role="owner")
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_suggestions_initialized_on_creation(self):
        project = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="my-node-app",
            display_name="My Node App",
            filesystem_path="/workspace/my-node-app",
        )
        self.assertEqual(project.suggestions, [])

        _init_project_suggestions_on_create(project)
        project.refresh_from_db()

        self.assertTrue(isinstance(project.suggestions, list))
        self.assertGreater(len(project.suggestions), 0)
        labels = [item["label"] for item in project.suggestions]
        self.assertIn("Git diff & PR", labels)

    def test_suggestions_view_returns_from_db_without_ai(self):
        saved_suggestions = [
            {"label": "Custom DB Suggestion", "prompt": "Test prompt from DB", "category": "code"}
        ]
        project = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="db-project",
            display_name="DB Project",
            filesystem_path="/workspace/db-project",
            suggestions=saved_suggestions,
        )

        response = self.client.get(f"/sandbox/sandboxes/{project.uuid}/suggestions/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["source"], "db")
        self.assertEqual(data["suggestions"], saved_suggestions)

    def test_serializer_includes_suggestions(self):
        saved_suggestions = [
            {"label": "Build App", "prompt": "npm run build", "category": "run"}
        ]
        project = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug="serialized-proj",
            display_name="Serialized Proj",
            filesystem_path="/workspace/serialized-proj",
            suggestions=saved_suggestions,
        )

        data = SandboxSerializer(project).data
        self.assertIn("suggestions", data)
        self.assertEqual(data["suggestions"], saved_suggestions)
