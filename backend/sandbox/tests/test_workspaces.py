from io import BytesIO
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from chat.models import Conversation
from sandbox.models import Sandbox, Workspace, WorkspaceInvitation, WorkspaceMembership


User = get_user_model()


@override_settings(
    SANDBOX_PROVIDER="docker",
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    DEFAULT_FROM_EMAIL="noreply@example.com",
    FRONTEND_BASE_URL="https://app.example.com",
)
class TeamWorkspaceApiTests(TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        settings = override_settings(LOCAL_WORKSPACE_ROOT=temp.name)
        settings.enable()
        self.addCleanup(settings.disable)
        self.enterContext(patch("sandbox.views.initialize_project_repository"))
        self.owner = User.objects.create_user(
            username="workspace-owner",
            email="owner@example.com",
            password="password123",
        )
        self.member = User.objects.create_user(
            username="workspace-member",
            email="member@example.com",
            password="password123",
        )
        self.outsider = User.objects.create_user(
            username="workspace-outsider",
            email="outsider@example.com",
            password="password123",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def create_team_workspace(self):
        response = self.client.post("/sandbox/workspaces/", {"name": "Acme Team"}, format="json")
        self.assertEqual(response.status_code, 201)
        return response.json()

    def test_workspace_creation_adds_owner_membership(self):
        payload = self.create_team_workspace()
        workspace = Workspace.objects.get(uuid=payload["uuid"])
        membership = WorkspaceMembership.objects.get(workspace=workspace, user=self.owner)

        self.assertEqual(membership.role, WorkspaceMembership.ROLE_OWNER)
        self.assertEqual(payload["member_count"], 1)
        self.assertEqual(payload["user_role"], "owner")

    def test_owner_invites_member_who_must_accept_before_accessing_workspace(self):
        payload = self.create_team_workspace()
        workspace_uuid = payload["uuid"]

        invite_response = self.client.post(
            f"/sandbox/workspaces/{workspace_uuid}/members/",
            {"email": self.member.email, "role": "member"},
            format="json",
        )
        self.assertEqual(invite_response.status_code, 201)
        invitation = WorkspaceInvitation.objects.get(uuid=invite_response.json()["uuid"])
        self.assertEqual(invitation.status, WorkspaceInvitation.STATUS_PENDING)
        self.assertFalse(WorkspaceMembership.objects.filter(workspace_id=workspace_uuid, user=self.member).exists())
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn(str(invitation.token), mail.outbox[0].body)
        self.assertIn("https://app.example.com/workspaces/invitations", mail.outbox[0].body)

        project_response = self.client.post(
            "/sandbox/sandbox-tools/list/",
            {
                "action": "create",
                "workspace_uuid": workspace_uuid,
                "display_name": "Website",
                "slug": "website",
                "filesystem_path": "/workspace/website",
            },
            format="json",
        )
        self.assertEqual(project_response.status_code, 201)

        member_client = APIClient()
        member_client.force_authenticate(self.member)
        before_acceptance = member_client.get("/sandbox/workspaces/")
        self.assertNotIn(workspace_uuid, [item["uuid"] for item in before_acceptance.json()])

        accept_response = member_client.post(
            f"/sandbox/workspace-invitations/{invitation.token}/accept/",
            format="json",
        )
        self.assertEqual(accept_response.status_code, 200)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, WorkspaceInvitation.STATUS_ACCEPTED)

        workspaces_response = member_client.get("/sandbox/workspaces/")
        projects_response = member_client.get("/sandbox/sandbox-tools/list/", {"workspace_uuid": workspace_uuid})

        self.assertEqual(workspaces_response.status_code, 200)
        self.assertIn(workspace_uuid, [item["uuid"] for item in workspaces_response.json()])
        self.assertEqual(projects_response.status_code, 200)
        self.assertEqual(
            [item["display_name"] for item in projects_response.json()["sandboxes"]],
            ["Website"],
        )

    def test_invitation_can_only_be_accepted_by_the_invited_email(self):
        payload = self.create_team_workspace()
        invitation_response = self.client.post(
            f"/sandbox/workspaces/{payload['uuid']}/members/",
            {"email": self.member.email, "role": "member"},
            format="json",
        )
        invitation = WorkspaceInvitation.objects.get(uuid=invitation_response.json()["uuid"])

        outsider_client = APIClient()
        outsider_client.force_authenticate(self.outsider)
        response = outsider_client.post(
            f"/sandbox/workspace-invitations/{invitation.token}/accept/",
            format="json",
        )

        self.assertEqual(response.status_code, 403)
        self.assertFalse(WorkspaceMembership.objects.filter(workspace_id=payload["uuid"], user=self.outsider).exists())

    def test_regular_member_cannot_add_other_members(self):
        payload = self.create_team_workspace()
        workspace_uuid = payload["uuid"]
        WorkspaceMembership.objects.create(
            workspace_id=workspace_uuid,
            user=self.member,
            role=WorkspaceMembership.ROLE_MEMBER,
        )

        member_client = APIClient()
        member_client.force_authenticate(self.member)
        response = member_client.post(
            f"/sandbox/workspaces/{workspace_uuid}/members/",
            {"email": self.outsider.email, "role": "member"},
            format="json",
        )

        self.assertEqual(response.status_code, 403)

    def test_projects_are_scoped_to_the_selected_workspace(self):
        team = self.create_team_workspace()
        personal = Workspace.objects.filter(owner=self.owner).exclude(uuid=team["uuid"]).first()
        self.assertIsNotNone(personal)

        team_project = Sandbox.objects.create(
            user=self.owner,
            workspace_id=team["uuid"],
            slug="team-project",
            display_name="Team Project",
            filesystem_path="/workspace/team-project",
        )
        response = self.client.get(
            "/sandbox/sandbox-tools/list/",
            {"workspace_uuid": team["uuid"]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["uuid"] for item in response.json()["sandboxes"]], [str(team_project.uuid)])
        self.assertFalse(any(item["workspace_uuid"] == str(personal.uuid) for item in response.json()["sandboxes"]))

    def test_project_conversations_are_visible_to_workspace_members(self):
        payload = self.create_team_workspace()
        workspace = Workspace.objects.get(uuid=payload["uuid"])
        WorkspaceMembership.objects.create(
            workspace=workspace,
            user=self.member,
            role=WorkspaceMembership.ROLE_MEMBER,
        )
        project = Sandbox.objects.create(
            user=self.owner,
            workspace=workspace,
            slug="shared-chat",
            display_name="Shared Chat",
            filesystem_path="/workspace/shared-chat",
        )
        conversation = Conversation.objects.create(user=self.owner, title="Roadmap")
        project.conversations.add(conversation)

        member_client = APIClient()
        member_client.force_authenticate(self.member)
        list_response = member_client.get("/conversations/", {"project_uuid": str(project.uuid)})
        detail_response = member_client.get(f"/conversations/{conversation.uuid}/")

        self.assertEqual(list_response.status_code, 200)
        self.assertEqual(list_response.json()["conversations"][0]["title"], "Roadmap")
        self.assertEqual(detail_response.status_code, 200)

    def test_cancel_workspace_invitation(self):
        payload = self.create_team_workspace()
        workspace_uuid = payload["uuid"]

        # Send invite
        invite_response = self.client.post(
            f"/sandbox/workspaces/{workspace_uuid}/members/",
            {"email": "cancel-me@example.com", "role": "member"},
            format="json",
        )
        self.assertEqual(invite_response.status_code, 201)
        invitation_uuid = invite_response.json()["uuid"]
        self.assertTrue(WorkspaceInvitation.objects.filter(uuid=invitation_uuid).exists())

        # Non-admin / uninvited cannot cancel
        member_client = APIClient()
        member_client.force_authenticate(self.member)
        forbidden_response = member_client.delete(
            f"/sandbox/workspaces/{workspace_uuid}/invitations/{invitation_uuid}/"
        )
        self.assertEqual(forbidden_response.status_code, 404)  # member not in workspace yet

        # Workspace owner can cancel
        cancel_response = self.client.delete(
            f"/sandbox/workspaces/{workspace_uuid}/invitations/{invitation_uuid}/"
        )
        self.assertEqual(cancel_response.status_code, 204)
        self.assertFalse(WorkspaceInvitation.objects.filter(uuid=invitation_uuid).exists())

        # Calling again gives 404
        second_cancel = self.client.delete(
            f"/sandbox/workspaces/{workspace_uuid}/invitations/{invitation_uuid}/"
        )
        self.assertEqual(second_cancel.status_code, 404)

    def _create_sample_image(self, name="avatar.png", size=(40, 40)):
        buf = BytesIO()
        image = Image.new("RGB", size, color=(50, 100, 200))
        image.save(buf, format="PNG")
        buf.seek(0)
        return SimpleUploadedFile(name, buf.getvalue(), content_type="image/png")

    def test_upload_and_remove_workspace_profile_picture(self):
        payload = self.create_team_workspace()
        workspace_uuid = payload["uuid"]
        workspace = Workspace.objects.get(uuid=workspace_uuid)
        self.assertFalse(bool(workspace.profile_picture))

        # Upload profile picture
        image_file = self._create_sample_image("team_logo.png")
        patch_response = self.client.patch(
            f"/sandbox/workspaces/{workspace_uuid}/",
            {"profile_picture": image_file},
            format="multipart",
        )
        self.assertEqual(patch_response.status_code, 200)
        data = patch_response.json()
        self.assertTrue(data["profile_picture"])
        self.assertIn("workspace-acme-team", data["profile_picture"])
        self.assertTrue(data.get("profile_picture_blur_data_url"))

        workspace.refresh_from_db()
        self.assertTrue(bool(workspace.profile_picture))

        # Remove profile picture
        remove_response = self.client.patch(
            f"/sandbox/workspaces/{workspace_uuid}/",
            {"profile_picture": ""},
            format="multipart",
        )
        self.assertEqual(remove_response.status_code, 200)
        remove_data = remove_response.json()
        self.assertIsNone(remove_data["profile_picture"])
        self.assertIsNone(remove_data.get("profile_picture_blur_data_url"))

        workspace.refresh_from_db()
        self.assertFalse(bool(workspace.profile_picture))

    def test_regular_member_cannot_update_workspace_profile_picture(self):
        payload = self.create_team_workspace()
        workspace_uuid = payload["uuid"]
        WorkspaceMembership.objects.create(
            workspace_id=workspace_uuid,
            user=self.member,
            role=WorkspaceMembership.ROLE_MEMBER,
        )

        member_client = APIClient()
        member_client.force_authenticate(self.member)
        image_file = self._create_sample_image()
        response = member_client.patch(
            f"/sandbox/workspaces/{workspace_uuid}/",
            {"profile_picture": image_file},
            format="multipart",
        )
        self.assertEqual(response.status_code, 403)

    def test_workspace_profile_picture_size_limit(self):
        payload = self.create_team_workspace()
        workspace_uuid = payload["uuid"]

        # Create oversized mock file (larger than PROFILE_PICTURE_MAX_SIZE, which is 10MB)
        oversized_data = b"x" * (11 * 1024 * 1024)
        large_file = SimpleUploadedFile("huge.png", oversized_data, content_type="image/png")
        response = self.client.patch(
            f"/sandbox/workspaces/{workspace_uuid}/",
            {"profile_picture": large_file},
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("too large", response.json().get("error", ""))
