import time
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from social_django.models import UserSocialAuth

from authentication.gitlab_connection import fresh_gitlab_token


def _response(status, payload=None, headers=None):
    response = Mock(status_code=status, headers=headers or {})
    response.json.return_value = payload if payload is not None else {}
    response.raise_for_status = Mock()
    return response


@override_settings(GITLAB_CLIENT_ID="cid", GITLAB_CLIENT_SECRET="secret", GITLAB_BASE_URL="https://gitlab.example.com")
class GitlabReposTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="gitlab-repos", email="gl@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def connect(self, **extra):
        return UserSocialAuth.objects.create(
            user=self.user, provider="gitlab", uid="7",
            extra_data={"access_token": "old", "refresh_token": "refresh", "login": "gl-user", "scope": "read_user read_repository", **extra},
        )

    def test_not_connected(self):
        data = self.client.get("/sandbox/gitlab/repos/").json()
        self.assertEqual(data["reason"], "not_connected")
        self.assertEqual(data["base_url"], "https://gitlab.example.com")

    def test_lists_member_projects(self):
        self.connect(expires_at=int(time.time()) + 3600)
        projects = [
            {"name": "app", "path_with_namespace": "grp/sub/app", "http_url_to_repo": "https://gitlab.example.com/grp/sub/app.git", "visibility": "private", "default_branch": "develop", "description": "d"},
            {"name": "pub", "path_with_namespace": "grp/pub", "http_url_to_repo": "https://gitlab.example.com/grp/pub.git", "visibility": "public", "default_branch": None},
        ]
        with patch("requests.get", return_value=_response(200, projects, {"X-Next-Page": "2"})) as get:
            data = self.client.get("/sandbox/gitlab/repos/").json()
        self.assertEqual(get.call_args.args[0], "https://gitlab.example.com/api/v4/projects")
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer old")
        self.assertTrue(data["connected"] and data["has_next"] and data["can_access_private"])
        self.assertEqual([r["full_name"] for r in data["repos"]], ["grp/sub/app", "grp/pub"])
        self.assertTrue(data["repos"][0]["private"])
        self.assertFalse(data["repos"][1]["private"])
        self.assertEqual(data["repos"][1]["default_branch"], "main")

    def test_refreshes_token_after_401(self):
        connection = self.connect()
        refreshed = _response(200, {"access_token": "new", "refresh_token": "refresh2", "expires_in": 7200})
        with patch("requests.get", side_effect=[_response(401), _response(200, [])]) as get, patch("authentication.gitlab_connection.requests.post", return_value=refreshed):
            data = self.client.get("/sandbox/gitlab/repos/").json()
        self.assertTrue(data["connected"])
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer new")
        connection.refresh_from_db()
        self.assertEqual(connection.extra_data["refresh_token"], "refresh2")

    def test_expired_when_refresh_fails(self):
        self.connect()
        with patch("requests.get", return_value=_response(401)), patch("authentication.gitlab_connection.requests.post", return_value=_response(400)):
            data = self.client.get("/sandbox/gitlab/repos/").json()
        self.assertEqual(data["reason"], "expired")

    def test_fresh_token_refreshes_only_near_expiry(self):
        valid = self.connect(expires_at=int(time.time()) + 3600)
        with patch("authentication.gitlab_connection.requests.post") as post:
            self.assertEqual(fresh_gitlab_token(valid), "old")
        post.assert_not_called()
        valid.extra_data["expires_at"] = int(time.time()) + 10
        with patch("authentication.gitlab_connection.requests.post", return_value=_response(200, {"access_token": "new", "expires_in": 7200})):
            self.assertEqual(fresh_gitlab_token(valid), "new")
