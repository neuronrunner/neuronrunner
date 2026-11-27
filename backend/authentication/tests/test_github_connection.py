from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from social_django.models import UserSocialAuth

from sandbox.services.sandbox_service import SandboxBootstrapService


@override_settings(SOCIAL_AUTH_GITHUB_KEY="test-client", SOCIAL_AUTH_GITHUB_SECRET="test-secret", FRONTEND_BASE_URL="http://localhost:3000", CORS_ALLOWED_ORIGINS=["http://localhost:3000"], CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class GithubConnectionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="github-connect", email="connect@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def start(self):
        response = self.client.post("/auth/github/connect/", {}, format="json", HTTP_ORIGIN="http://localhost:3000")
        self.assertEqual(response.status_code, 200)
        return parse_qs(urlsplit(response.json()["authorization_url"]).query)

    def callback(self, state, *, scopes="repo,read:user", uid=42, error=None):
        token = Mock(status_code=200)
        token.json.return_value = {"access_token": "private-test-token", "scope": scopes}
        profile = Mock(status_code=200, headers={})
        profile.json.return_value = {"id": uid, "login": "test-github"}
        with patch("authentication.github_connection.requests.post", return_value=token) as exchange, patch("authentication.github_connection.requests.get", return_value=profile):
            response = self.client.get("/auth/github/callback/", {"state": state, **({"error": error} if error else {"code": "test-code"})})
        return response, exchange

    def test_start_is_authenticated_and_requests_repo_scope_without_putting_jwt_in_url(self):
        params = self.start()
        self.assertIn("repo", params["scope"][0].split())
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertTrue(params["state"][0].startswith("nr-connect:"))
        self.assertNotIn("test-secret", str(params))
        self.client.force_authenticate(None)
        self.assertIn(self.client.post("/auth/github/connect/", {}, format="json").status_code, (401, 403))

    def test_callback_links_to_signed_in_user_without_login_payload_or_project_creation(self):
        workspace_count = self.user.owned_workspaces.count()
        state = self.start()["state"][0]
        response, exchange = self.callback(state)
        self.assertEqual(response.status_code, 200)
        connection = UserSocialAuth.objects.get(user=self.user, provider="github")
        self.assertEqual(connection.extra_data["access_token"], "private-test-token")
        self.assertEqual(connection.extra_data["scope"], "repo,read:user")
        self.assertIn('"source": "github-connection"', response.content.decode())
        self.assertIn('"connected": true', response.content.decode())
        self.assertIn('"http://localhost:3000"', response.content.decode())
        self.assertNotIn("private-test-token", response.content.decode())
        self.assertNotIn('"token"', response.content.decode())
        self.assertEqual(self.user.owned_workspaces.count(), workspace_count)
        self.assertIn("code_verifier", exchange.call_args.kwargs["data"])

    def test_state_cannot_be_tampered_or_reused(self):
        state = self.start()["state"][0]
        with patch("authentication.github_connection.requests.post") as exchange:
            response = self.client.get("/auth/github/callback/", {"state": state + "tampered", "code": "test"})
            self.assertEqual(response.status_code, 400)
            exchange.assert_not_called()
        self.callback(state)
        response, exchange = self.callback(state)
        self.assertEqual(response.status_code, 400)
        exchange.assert_not_called()

    def test_denied_authorization_does_not_change_connection(self):
        response, exchange = self.callback(self.start()["state"][0], error="access_denied")
        self.assertIn("cancelled", response.content.decode())
        self.assertFalse(UserSocialAuth.objects.filter(user=self.user).exists())
        exchange.assert_not_called()

    def test_missing_repo_scope_does_not_replace_existing_private_token(self):
        connection = UserSocialAuth.objects.create(user=self.user, provider="github", uid="42", extra_data={"access_token": "old-private-token"})
        response, _ = self.callback(self.start()["state"][0], scopes="read:user")
        self.assertIn("did not grant private repository access", response.content.decode())
        connection.refresh_from_db()
        self.assertEqual(connection.extra_data["access_token"], "old-private-token")

    def test_a_different_local_users_github_account_is_not_transferred(self):
        other = get_user_model().objects.create_user(username="other-connect", email="other@example.com")
        UserSocialAuth.objects.create(user=other, provider="github", uid="42", extra_data={"access_token": "other-token"})
        response, _ = self.callback(self.start()["state"][0])
        self.assertIn("linked to another Neuron Runner account", response.content.decode())
        self.assertFalse(UserSocialAuth.objects.filter(user=self.user).exists())

    def test_untrusted_origin_and_missing_server_configuration_are_reported(self):
        response = self.client.post("/auth/github/connect/", {}, format="json", HTTP_ORIGIN="https://untrusted.example")
        self.assertEqual(response.status_code, 400)
        with override_settings(SOCIAL_AUTH_GITHUB_SECRET=""):
            self.assertEqual(self.client.post("/auth/github/connect/", {}, format="json").status_code, 503)

    def test_unavailable_github_finishes_popup_with_actionable_error(self):
        import requests
        with patch("authentication.github_connection.requests.post", side_effect=requests.Timeout):
            response = self.client.get("/auth/github/callback/", {"state": self.start()["state"][0], "code": "test"})
        self.assertIn("Try again", response.content.decode())
        self.assertFalse(UserSocialAuth.objects.filter(user=self.user).exists())

    def test_reconnect_updates_the_same_user_connection(self):
        connection = UserSocialAuth.objects.create(user=self.user, provider="github", uid="42", extra_data={"access_token": "old-token", "scope": "public_repo"})
        self.callback(self.start()["state"][0])
        connection.refresh_from_db()
        self.assertEqual(connection.extra_data["access_token"], "private-test-token")
        self.assertEqual(UserSocialAuth.objects.filter(user=self.user).count(), 1)

    def test_connecting_a_different_account_replaces_the_existing_connection(self):
        old = UserSocialAuth.objects.create(
            user=self.user, provider="github", uid="42",
            extra_data={"access_token": "old-token", "login": "old-login"},
        )
        with patch("authentication.github_connection.requests.delete") as revoke:
            revoke.return_value.status_code = 204
            response, _ = self.callback(self.start()["state"][0], uid=43)
        self.assertIn('"connected": true', response.content.decode())
        self.assertFalse(UserSocialAuth.objects.filter(pk=old.pk).exists())
        connections = UserSocialAuth.objects.filter(user=self.user, provider="github")
        self.assertEqual(connections.count(), 1)
        self.assertEqual(connections.get().uid, "43")
        revoke.assert_called_once_with(
            "https://api.github.com/applications/test-client/token",
            auth=("test-client", "test-secret"),
            headers={"Accept": "application/vnd.github+json"},
            json={"access_token": "old-token"},
            timeout=5,
        )

    def test_account_list_returns_only_the_active_connection(self):
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="42", extra_data={"login": "old-login"})
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="43", extra_data={"login": "current-login"})
        self.assertEqual(
            self.client.get("/auth/github/accounts/").json(),
            {"accounts": [{"id": "43", "login": "current-login"}]},
        )

    def test_repositories_include_private_and_organization_repos_and_page_results(self):
        root = SandboxBootstrapService.ensure_personal_filesystem(self.user)
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="42", extra_data={"access_token": "private-test-token", "login": "test-github"})
        github = Mock(status_code=200, headers={"X-OAuth-Scopes": "repo, read:user"}, links={"next": {"url": "next-page"}})
        github.json.return_value = [{"name": "private", "full_name": "team/private", "clone_url": "https://github.com/team/private.git", "private": True}]
        with patch("requests.get", return_value=github) as get:
            response = self.client.get(f"/sandbox/sandboxes/{root.uuid}/github/repos/", {"page": 2})
        data = response.json()
        self.assertTrue(data["connected"])
        self.assertTrue(data["can_access_private"])
        self.assertTrue(data["repos"][0]["private"])
        self.assertTrue(data["has_next"])
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer private-test-token")
        self.assertEqual(get.call_args.kwargs["params"]["visibility"], "all")
        self.assertIn("organization_member", get.call_args.kwargs["params"]["affiliation"])
        self.assertEqual(get.call_args.kwargs["params"]["page"], 2)

    def test_expired_or_under_scoped_connection_is_visible_and_not_deleted(self):
        root = SandboxBootstrapService.ensure_personal_filesystem(self.user)
        connection = UserSocialAuth.objects.create(user=self.user, provider="github", uid="42", extra_data={"access_token": "old-token"})
        github = Mock(status_code=200, headers={"X-OAuth-Scopes": "public_repo"}, links={})
        github.json.return_value = []
        url = f"/sandbox/sandboxes/{root.uuid}/github/repos/"
        with patch("requests.get", return_value=github):
            self.assertFalse(self.client.get(url).json()["can_access_private"])
            github.status_code = 401
            self.assertEqual(self.client.get(url).json()["reason"], "expired")
        self.assertTrue(UserSocialAuth.objects.filter(pk=connection.pk).exists())

    def test_repositories_require_workspace_access_and_distinguish_sso_errors(self):
        root = SandboxBootstrapService.ensure_personal_filesystem(self.user)
        other = get_user_model().objects.create_user(username="outsider-connect", email="outsider@example.com")
        self.client.force_authenticate(other)
        with patch("requests.get") as github:
            self.assertEqual(self.client.get(f"/sandbox/sandboxes/{root.uuid}/github/repos/").status_code, 404)
            github.assert_not_called()
        self.client.force_authenticate(self.user)
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="42", extra_data={"access_token": "test-token"})
        github = Mock(status_code=403, headers={"X-GitHub-SSO": "required; url=https://github.com/orgs/test/sso"})
        with patch("requests.get", return_value=github):
            response = self.client.get(f"/sandbox/sandboxes/{root.uuid}/github/repos/")
        self.assertEqual(response.status_code, 502)
        self.assertIn("SSO", response.json()["error"])

    def test_redirect_uri_defaults_to_callback_url(self):
        params = self.start()
        self.assertIn("redirect_uri", params)
        self.assertTrue(params["redirect_uri"][0].endswith("/auth/github/callback/"))

    def test_redirect_uri_included_when_configured(self):
        with self.settings(GITHUB_REDIRECT_URI="http://localhost:8000/auth/github/callback/"):
            params = self.start()
            self.assertEqual(params["redirect_uri"], ["http://localhost:8000/auth/github/callback/"])

    def test_github_login_oauth_start_view(self):
        # AllowAny login start endpoint
        self.client.force_authenticate(None)
        res = self.client.get("/auth/github/login/")
        self.assertEqual(res.status_code, 302)
        query = parse_qs(urlsplit(res.url).query)
        self.assertIn("redirect_uri", query)
        self.assertTrue(query["redirect_uri"][0].endswith("/auth/github/callback/"))
        self.assertEqual(query["client_id"], ["test-client"])

        # When configured
        with self.settings(GITHUB_REDIRECT_URI="https://api.neuronrunner.com/auth/github/callback/"):
            res2 = self.client.get("/auth/github/login/")
            query2 = parse_qs(urlsplit(res2.url).query)
            self.assertEqual(query2["redirect_uri"], ["https://api.neuronrunner.com/auth/github/callback/"])

    def test_callback_without_trailing_slash_resolves(self):
        # Ensure /auth/github/callback resolves and handles request
        response = self.client.get("/auth/github/callback", {"code": ""})
        self.assertEqual(response.status_code, 400)

    def test_user_github_repos_without_sandbox_uuid(self):
        self.client.force_authenticate(self.user)
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="42", extra_data={"access_token": "valid-token"})
        github = Mock(status_code=200, json=lambda: [{"name": "repo1", "full_name": "user/repo1", "clone_url": "https://github.com/user/repo1.git", "private": True}], headers={"X-OAuth-Scopes": "repo"}, links={})
        with patch("requests.get", return_value=github):
            response = self.client.get("/sandbox/github/repos/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["connected"])
        self.assertTrue(response.json()["can_access_private"])
        self.assertEqual(len(response.json()["repos"]), 1)

    def test_popup_response_sets_coop_header(self):
        from authentication.github_connection import popup_response
        response = popup_response("https://neuronrunner.com", connected=True)
        self.assertEqual(response.headers.get("Cross-Origin-Opener-Policy"), "unsafe-none")

    def test_account_disconnect_is_scoped_to_the_signed_in_user(self):
        connection = UserSocialAuth.objects.create(
            user=self.user, provider="github", uid="42",
            extra_data={"access_token": "mine-token", "login": "mine"},
        )
        other = get_user_model().objects.create_user(username="other-accounts", email="other-accounts@example.com")
        UserSocialAuth.objects.create(
            user=other, provider="github", uid="99",
            extra_data={"access_token": "other-token", "login": "other"},
        )
        self.assertEqual(
            self.client.get("/auth/github/accounts/").json(),
            {"accounts": [{"id": "42", "login": "mine"}]},
        )
        with patch("authentication.github_connection.requests.delete") as revoke:
            revoke.return_value.status_code = 204
            response = self.client.delete("/auth/github/accounts/99/")
            self.assertFalse(response.json()["deleted"])
            revoke.assert_not_called()
            self.assertTrue(UserSocialAuth.objects.filter(user=other, provider="github", uid="99").exists())

            response = self.client.delete("/auth/github/accounts/42/")
            self.assertTrue(response.json()["deleted"])
            revoke.assert_called_once_with(
                "https://api.github.com/applications/test-client/token",
                auth=("test-client", "test-secret"),
                headers={"Accept": "application/vnd.github+json"},
                json={"access_token": "mine-token"},
                timeout=5,
            )
        self.assertFalse(UserSocialAuth.objects.filter(pk=connection.pk).exists())
        self.client.force_authenticate(None)
        self.assertIn(self.client.delete("/auth/github/accounts/42/").status_code, (401, 403))

    def test_disconnect_removes_local_link_when_github_revocation_fails(self):
        connection = UserSocialAuth.objects.create(
            user=self.user, provider="github", uid="42",
            extra_data={"access_token": "mine-token", "login": "mine"},
        )
        import requests
        with patch("authentication.github_connection.requests.delete", side_effect=requests.Timeout):
            response = self.client.delete("/auth/github/accounts/42/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["deleted"])
        self.assertFalse(UserSocialAuth.objects.filter(pk=connection.pk).exists())

    def test_github_oauth_login_nonce_fallback_is_one_time(self):
        self.client.force_authenticate(None)
        nonce = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
        start_res = self.client.get("/auth/github/login/", {"origin": "http://localhost:3000", "nonce": nonce})
        self.assertEqual(start_res.status_code, 302)
        state = parse_qs(urlsplit(start_res.url).query)["state"][0]

        token_res = Mock(status_code=200, json=lambda: {"access_token": "gh-token", "scope": "repo,user"})
        user_res = Mock(
            status_code=200,
            json=lambda: {"id": 987654, "login": "gh-fallback-user", "email": "fallback@example.com"},
            headers={"X-OAuth-Scopes": "repo,user"},
        )
        with patch("requests.post", return_value=token_res), patch("requests.get", return_value=user_res):
            cb_res = self.client.get("/auth/github/callback/", {"code": "ok-code", "state": state})
        self.assertEqual(cb_res.status_code, 200)

        first = self.client.get("/auth/github/result/", {"nonce": nonce})
        self.assertEqual(first.status_code, 200)
        payload = first.json()
        self.assertEqual(payload["source"], "github-oauth")
        self.assertIn("token", payload)
        self.assertEqual(payload["user"]["username"], "gh-fallback-user")

        second = self.client.get("/auth/github/result/", {"nonce": nonce})
        self.assertEqual(second.status_code, 404)



