import json
from decimal import Decimal
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sandbox.models import Sandbox, Workspace, WorkspaceMembership
from utils.ssrf import is_safe_external_url

User = get_user_model()


class UserProfilePrivacySecurityTests(TestCase):
    def setUp(self):
        self.user_a = User.objects.create_user(
            username="alice",
            email="alice@example.com",
            password="StrongPassword123!",
        )

        self.user_b = User.objects.create_user(
            username="bob",
            email="bob@example.com",
            password="StrongPassword456!",
        )
        self.client = APIClient()

    def test_anonymous_user_cannot_see_sensitive_fields(self):
        response = self.client.get(f"/users/{self.user_a.username}/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["username"], "alice")
        self.assertNotIn("email", data)
        self.assertNotIn("memory_enabled", data)

    def test_other_user_cannot_see_sensitive_fields(self):
        self.client.force_authenticate(self.user_b)
        response = self.client.get(f"/users/{self.user_a.username}/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["username"], "alice")
        self.assertNotIn("email", data)
        self.assertNotIn("memory_enabled", data)

    def test_owner_can_see_own_sensitive_fields(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.get("/users/me/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["username"], "alice")
        self.assertEqual(data["email"], "alice@example.com")
        self.assertIn("memory_enabled", data)


class PasswordValidationAndSecurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="securityuser",
            email="sec@example.com",
            password="InitialStrongPassword123!",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_change_password_requires_correct_current_password(self):
        response = self.client.post("/users/change-password/", {
            "current_password": "WrongPassword!",
            "new_password": "NewStrongPassword123!",
        }, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Current password is incorrect", response.json().get("error", ""))

    def test_change_password_validates_new_password_strength(self):
        response = self.client.post("/users/change-password/", {
            "current_password": "InitialStrongPassword123!",
            "new_password": "123",
        }, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertTrue(bool(response.json().get("error")))

    def test_change_password_succeeds_with_valid_password(self):
        response = self.client.post("/users/change-password/", {
            "current_password": "InitialStrongPassword123!",
            "new_password": "BrandNewStrongPassword456!",
        }, format="json")
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("BrandNewStrongPassword456!"))


class SSRFProtectionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="ssrfuser",
            email="ssrf@example.com",
            password="StrongPassword123!",
        )
        self.workspace = Workspace.objects.create(name="SSRF Workspace", slug="ssrf-ws", owner=self.user)
        WorkspaceMembership.objects.create(
            workspace=self.workspace,
            user=self.user,
            role="owner",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_ssrf_detector_blocks_dangerous_addresses(self):
        dangerous_targets = [
            "http://127.0.0.1:8000/api",
            "http://localhost:3000",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5:9000",
            "http://192.168.1.100/admin",
            "http://172.16.1.1/internal",
            "http://[::1]/",
            "ftp://example.com",
            "file:///etc/passwd",
        ]
        for target in dangerous_targets:
            safe, err = is_safe_external_url(target)
            self.assertFalse(safe, f"Target {target} should be blocked, but was allowed! Err: {err}")

    def test_test_custom_model_view_blocks_private_url(self):
        response = self.client.post(
            f"/sandbox/workspaces/{self.workspace.uuid}/custom-models/test/",
            {
                "provider": "custom",
                "external_model_id": "test-model",
                "custom_base_url": "http://127.0.0.1:8000",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json().get("success"))
        self.assertIn("Disallowed custom endpoint URL", response.json().get("error", ""))


class GithubOAuthSecurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="oauthuser",
            email="oauth@example.com",
            password="StrongPassword123!",
        )
        self.client = APIClient()

    @override_settings(
        SOCIAL_AUTH_GITHUB_KEY="test-id",
        SOCIAL_AUTH_GITHUB_SECRET="test-secret",
        FRONTEND_BASE_URL="https://app.neuronrunner.com",
        CORS_ALLOWED_ORIGINS=["https://app.neuronrunner.com"],
    )
    def test_callback_never_uses_wildcard_target_origin(self):
        mock_token = Mock(status_code=200)
        mock_token.json.return_value = {"access_token": "gh_secret_token", "scope": "repo"}

        mock_profile = Mock(status_code=200, headers={"X-OAuth-Scopes": "repo"})
        mock_profile.json.return_value = {"id": 999999, "login": "oauthuser", "email": "oauth@example.com"}

        with patch("requests.post", return_value=mock_token), \
             patch("requests.get", return_value=mock_profile):
            response = self.client.get("/auth/github/callback/?code=fakecode")

        self.assertEqual(response.status_code, 200)
        content = response.content.decode("utf-8")

        # Must NOT use wildcard "*"
        self.assertNotIn('postMessage(payload, "*")', content)
        # Must target the frontend base URL
        self.assertIn('https://app.neuronrunner.com', content)

    @override_settings(
        SOCIAL_AUTH_GITHUB_KEY="test-id",
        SOCIAL_AUTH_GITHUB_SECRET="test-secret",
        FRONTEND_BASE_URL="https://app.neuronrunner.com",
        CORS_ALLOWED_ORIGINS=["https://app.neuronrunner.com"],
    )
    def test_github_oauth_prevents_account_takeover_by_username_collision(self):
        # Victim exists with username "victor" and victim's email
        victim = User.objects.create_user(
            username="victor",
            email="victor@company.com",
            password="VictimSecretPassword123!",
        )

        mock_token = Mock(status_code=200)
        mock_token.json.return_value = {"access_token": "gh_attacker_token", "scope": "repo"}

        # Attacker on GitHub has login "victor" but a completely different email
        mock_profile = Mock(status_code=200, headers={"X-OAuth-Scopes": "repo"})
        mock_profile.json.return_value = {"id": 1234567, "login": "victor", "email": "attacker@evil.com"}

        with patch("requests.post", return_value=mock_token), \
             patch("requests.get", return_value=mock_profile):
            response = self.client.get("/auth/github/callback/?code=attacker_code")

        self.assertEqual(response.status_code, 200)

        # Attacker must NOT have taken over victim's user account
        victim.refresh_from_db()
        self.assertEqual(victim.email, "victor@company.com")
        from social_django.models import UserSocialAuth
        self.assertFalse(UserSocialAuth.objects.filter(user=victim).exists())

        # A new, separate user must have been created for the attacker
        attacker_user = User.objects.filter(email="attacker@evil.com").first()
        self.assertIsNotNone(attacker_user)
        self.assertNotEqual(attacker_user.pk, victim.pk)
        self.assertTrue(attacker_user.username.startswith("victor_"))

    @override_settings(
        SOCIAL_AUTH_GITHUB_KEY="test-id",
        SOCIAL_AUTH_GITHUB_SECRET="test-secret",
        FRONTEND_BASE_URL="http://localhost:3000",
        CORS_ALLOWED_ORIGINS=["http://localhost:3000", "https://neuronrunner.com"],
    )
    def test_login_preserves_allowed_opener_origin_in_signed_state(self):
        from urllib.parse import parse_qs, urlsplit

        start_res = self.client.get("/auth/github/login/", {"origin": "https://neuronrunner.com"})
        self.assertEqual(start_res.status_code, 302)
        self.assertEqual(start_res.headers.get("Cross-Origin-Opener-Policy"), "unsafe-none")
        state = parse_qs(urlsplit(start_res.url).query)["state"][0]
        self.assertTrue(state.startswith("ghlogin:"))

        mock_token = Mock(status_code=200)
        mock_token.json.return_value = {"access_token": "gh_secret_token", "scope": "repo"}
        mock_profile = Mock(status_code=200, headers={"X-OAuth-Scopes": "repo"})
        mock_profile.json.return_value = {"id": 999999, "login": "oauthuser", "email": "oauth@example.com"}

        with patch("requests.post", return_value=mock_token), \
             patch("requests.get", return_value=mock_profile):
            cb_res = self.client.get("/auth/github/callback/", {"code": "fakecode", "state": state})

        self.assertEqual(cb_res.status_code, 200)
        content = cb_res.content.decode("utf-8")
        self.assertIn('window.opener.postMessage(payload, "https://neuronrunner.com")', content)
        self.assertNotIn("http://localhost:3000", content)

    @override_settings(
        SOCIAL_AUTH_GITHUB_KEY="test-id",
        SOCIAL_AUTH_GITHUB_SECRET="test-secret",
        FRONTEND_BASE_URL="https://app.neuronrunner.com",
        CORS_ALLOWED_ORIGINS=["https://app.neuronrunner.com"],
    )
    def test_login_rejects_untrusted_origin_and_tampered_state(self):
        from urllib.parse import parse_qs, urlsplit

        start_res = self.client.get("/auth/github/login/", {"origin": "https://evil.example"})
        self.assertEqual(start_res.status_code, 302)
        state = parse_qs(urlsplit(start_res.url).query)["state"][0]

        with patch("requests.post") as mock_post:
            tampered_res = self.client.get("/auth/github/callback/", {"code": "fakecode", "state": state + "tampered"})
        self.assertEqual(tampered_res.status_code, 400)
        mock_post.assert_not_called()

        mock_token = Mock(status_code=200)
        mock_token.json.return_value = {"access_token": "gh_secret_token", "scope": "repo"}
        mock_profile = Mock(status_code=200, headers={"X-OAuth-Scopes": "repo"})
        mock_profile.json.return_value = {"id": 999999, "login": "oauthuser", "email": "oauth@example.com"}

        with patch("requests.post", return_value=mock_token), \
             patch("requests.get", return_value=mock_profile):
            cb_res = self.client.get("/auth/github/callback/", {"code": "fakecode", "state": state})

        self.assertEqual(cb_res.status_code, 200)
        content = cb_res.content.decode("utf-8")
        self.assertIn('window.opener.postMessage(payload, "https://app.neuronrunner.com")', content)
        self.assertNotIn("https://evil.example", content)


class RateLimitingSecurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="rateuser",
            email="rate@example.com",
            password="StrongPassword123!",
        )
        self.client = APIClient()

    def test_login_throttling_enforced(self):
        client = APIClient()
        # Rate limit is 10/minute: first 10 requests are processed (HTTP 400), 11th returns 429
        for _ in range(10):
            res = client.post("/auth/login/", {"username": "rateuser", "password": "wrong"}, format="json")
            self.assertEqual(res.status_code, 400)

        # 11th request must be throttled with 429
        res = client.post("/auth/login/", {"username": "rateuser", "password": "wrong"}, format="json")
        self.assertEqual(res.status_code, 429)

    def test_change_password_throttling_enforced(self):
        client = APIClient()
        client.force_authenticate(self.user)
        # Rate limit is 10/minute: first 10 requests are processed (HTTP 400), 11th returns 429
        for _ in range(10):
            res = client.post("/users/change-password/", {"current_password": "wrong", "new_password": "NewStrongPass1!"}, format="json")
            self.assertEqual(res.status_code, 400)

        # 11th request must be throttled
        res = client.post("/users/change-password/", {"current_password": "wrong", "new_password": "NewStrongPass1!"}, format="json")
        self.assertEqual(res.status_code, 429)

    def setUp(self):
        self.user = User.objects.create_user(
            username="boxuser",
            email="box@example.com",
            password="StrongPassword123!",
        )
        self.workspace = Workspace.objects.create(name="Box Workspace", slug="box-ws", owner=self.user)
        WorkspaceMembership.objects.create(
            workspace=self.workspace,
            user=self.user,
            role="owner",
        )
        self.sandbox = Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            filesystem_path="/workspace/main",
            display_name="main",
            slug="main",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_git_clone_command_rejects_path_traversal_in_repo_name(self):
        malicious_urls = [
            "https://github.com/foo/../..",
            "https://github.com/foo/.git",
            "https://github.com/foo/bar;rm -rf",
        ]
        for url in malicious_urls:
            response = self.client.post(
                f"/sandbox/sandboxes/{self.sandbox.uuid}/git-clone-command/",
                {"repo_url": url},
                format="json",
            )
            self.assertEqual(response.status_code, 400)

    def test_file_upload_rejects_path_traversal(self):
        with patch("sandbox.views._has_running_vm", return_value=True):
            file = SimpleUploadedFile("test.txt", b"hello world")
            response = self.client.post(
                f"/sandbox/sandboxes/{self.sandbox.uuid}/files/upload/",
                {
                    "file": file,
                    "filename": "/workspace/../../etc/passwd",
                },
                format="multipart",
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("Path traversal", response.json().get("error", ""))

    def test_view_throttle_scopes_are_configured(self):
        from authentication.views import GithubOAuthCallbackView, GithubOAuthStartView
        from sandbox.views import SandboxFileUploadView, WorkspaceMembersView

        self.assertEqual(getattr(SandboxFileUploadView, "throttle_scope", None), "file_upload")
        self.assertEqual(getattr(WorkspaceMembersView, "throttle_scope", None), "send_invitation")
        self.assertEqual(getattr(GithubOAuthStartView, "throttle_scope", None), "oauth_start")
        self.assertEqual(getattr(GithubOAuthCallbackView, "throttle_scope", None), "oauth_callback")

    def test_message_attachment_sanitizes_filename(self):
        import os
        from chat.models import Conversation, Message
        from chat.views.predict import _create_message_attachments

        conv = Conversation.objects.create(user=self.user)
        msg = Message.objects.create(conversation=conv, role="user", content="hello")
        uploaded = SimpleUploadedFile("../../../etc/shadow", b"dummy content")

        written_paths = []
        def fake_write(project, dest, content):
            written_paths.append(dest)

        with patch("sandbox.services.sandbox_service.SandboxBootstrapService.conversation_project", return_value=self.sandbox), \
             patch("sandbox.services.volume_tools.write_file", side_effect=fake_write):
            _create_message_attachments(msg, [uploaded])

        self.assertEqual(len(written_paths), 1)
        self.assertEqual(written_paths[0], "/workspace/.uploads/shadow")
        self.assertNotIn("..", written_paths[0])

    def test_user_serializer_rejects_duplicate_email_and_username(self):
        from user.serializers import UserSerializer
        other_user = User.objects.create_user(
            username="otheruser",
            email="other@example.com",
            password="StrongPassword123!",
        )
        serializer = UserSerializer(self.user, data={"email": "other@example.com"}, partial=True)
        self.assertFalse(serializer.is_valid())
        self.assertIn("email", serializer.errors)

        serializer2 = UserSerializer(self.user, data={"username": "OTHERUSER"}, partial=True)
        self.assertFalse(serializer2.is_valid())
        self.assertIn("username", serializer2.errors)
