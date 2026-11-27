"""GitHub/GitLab issue import into native issues."""
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from social_django.models import UserSocialAuth

from issues.models import Issue
from issues.services import importer
from sandbox.models import Sandbox, Workspace, WorkspaceMembership

User = get_user_model()


def _response(payload, status=200, headers=None):
    response = MagicMock(status_code=status, headers=headers or {})
    response.json.return_value = payload
    return response


GITHUB_ITEMS = [
    {  # newest first, like the real API
        "number": 12,
        "title": "Closed as not planned",
        "body": "",
        "state": "closed",
        "state_reason": "not_planned",
        "labels": [],
        "html_url": "https://github.com/acme/app/issues/12",
        "user": {"login": "sam"},
        "created_at": "2026-03-01T10:00:00Z",
        "updated_at": "2026-03-02T10:00:00Z",
        "closed_at": "2026-03-02T10:00:00Z",
    },
    {"number": 11, "title": "A pull request", "state": "open", "pull_request": {"url": "x"}},
    {
        "number": 7,
        "title": "Crash on save",
        "body": "Steps to reproduce",
        "state": "open",
        "labels": [{"name": "bug", "color": "d73a4a"}],
        "html_url": "https://github.com/acme/app/issues/7",
        "user": {"login": "alex"},
        "created_at": "2026-01-05T08:30:00Z",
        "updated_at": "2026-01-06T08:30:00Z",
        "closed_at": None,
    },
]

GITLAB_ITEMS = [
    {
        "iid": 4,
        "title": "Pipeline fails",
        "description": "See log",
        "state": "opened",
        "labels": ["ci", "bug"],
        "web_url": "https://gitlab.com/group/sub/proj/-/issues/4",
        "author": {"username": "kim"},
        "created_at": "2026-02-01T09:00:00.000Z",
        "updated_at": "2026-02-02T09:00:00.000Z",
        "closed_at": None,
    },
    {
        "iid": 3,
        "title": "Old bug",
        "description": None,
        "state": "closed",
        "labels": [],
        "web_url": "https://gitlab.com/group/sub/proj/-/issues/3",
        "author": {"username": "lee"},
        "created_at": "2026-01-01T09:00:00.000Z",
        "updated_at": "2026-01-02T09:00:00.000Z",
        "closed_at": "2026-01-02T09:00:00.000Z",
    },
]


@override_settings(SANDBOX_PROVIDER="docker")
class IssueImportTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="owner", email="o@example.com", password="pw")
        self.workspace = Workspace.objects.create(name="WS", slug="ws", owner=self.user)
        WorkspaceMembership.objects.create(
            workspace=self.workspace, user=self.user, role=WorkspaceMembership.ROLE_OWNER
        )
        self.github_env = self._env("gh", "https://github.com/acme/app.git", "acme/app")
        self.gitlab_env = self._env("gl", "https://gitlab.com/group/sub/proj.git", "group/sub/proj")
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _env(self, slug, url, full_name):
        return Sandbox.objects.create(
            user=self.user,
            workspace=self.workspace,
            slug=slug,
            display_name=slug,
            filesystem_path=f"/workspace/{slug}",
            repo_url=url,
            repo_full_name=full_name,
        )

    def connect(self, provider, token="tok"):
        UserSocialAuth.objects.create(user=self.user, provider=provider, uid=f"{provider}-1", extra_data={"access_token": token})

    def post(self, env, **payload):
        return self.client.post(f"/issues/environments/{env.uuid}/import/", payload, format="json")

    def test_github_import_maps_state_labels_and_skips_pull_requests(self):
        self.connect("github", "gh-token")
        with patch("issues.services.importer.requests.get", return_value=_response(GITHUB_ITEMS)) as get:
            res = self.post(self.github_env, state="all")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json(), {"provider": "github", "imported": 2, "skipped": 0, "truncated": False})
        self.assertEqual(get.call_args.args[0], "https://api.github.com/repos/acme/app/issues")
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer gh-token")
        self.assertEqual(get.call_args.kwargs["params"]["state"], "all")

        crash = Issue.objects.get(sandbox=self.github_env, external_id="7")
        self.assertEqual((crash.number, crash.status, crash.creator_type), (1, "todo", "import"))
        self.assertEqual(crash.labels, [{"name": "bug", "color": "d73a4a"}])
        self.assertEqual((crash.external_source, crash.external_author), ("github", "alex"))
        self.assertEqual(crash.external_url, "https://github.com/acme/app/issues/7")
        self.assertEqual(crash.created_at.year, 2026)
        self.assertEqual(crash.created_at.month, 1)  # original timestamps are preserved
        skipped = Issue.objects.get(sandbox=self.github_env, external_id="12")
        self.assertEqual((skipped.number, skipped.status), (2, "cancelled"))  # oldest imported first
        self.assertIsNotNone(skipped.closed_at)
        self.assertFalse(Issue.objects.filter(sandbox=self.github_env, external_id="11").exists())

    def test_reimport_skips_existing_issues(self):
        with patch("issues.services.importer.requests.get", return_value=_response(GITHUB_ITEMS)):
            self.post(self.github_env, state="all")
            again = self.post(self.github_env, state="all").json()
        self.assertEqual((again["imported"], again["skipped"]), (0, 2))
        self.assertEqual(Issue.objects.filter(sandbox=self.github_env).count(), 2)

    def test_github_access_errors_are_actionable(self):
        with patch("issues.services.importer.requests.get", return_value=_response({}, 404)):
            res = self.post(self.github_env)
        self.assertEqual((res.status_code, res.json()["code"]), (400, "github_not_connected"))
        self.connect("github")
        with patch("issues.services.importer.requests.get", return_value=_response({}, 404)):
            res = self.post(self.github_env)
        self.assertEqual((res.status_code, res.json()["code"]), (400, "repository_unavailable"))
        limited = _response({}, 403, {"X-RateLimit-Remaining": "0"})
        with patch("issues.services.importer.requests.get", return_value=limited):
            res = self.post(self.github_env)
        self.assertEqual((res.status_code, res.json()["code"]), (502, "rate_limited"))
        with patch("issues.services.importer.requests.get", return_value=_response({}, 500)):
            self.assertEqual(self.post(self.github_env).status_code, 502)

    def test_gitlab_import_encodes_the_project_path_and_maps_state(self):
        self.connect("gitlab", "gl-token")
        with patch("issues.services.importer.requests.get", return_value=_response(GITLAB_ITEMS)) as get:
            res = self.post(self.gitlab_env, state="open")
        self.assertEqual(res.json(), {"provider": "gitlab", "imported": 2, "skipped": 0, "truncated": False})
        self.assertEqual(get.call_args.args[0], "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/issues")
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer gl-token")
        self.assertEqual(get.call_args.kwargs["params"]["state"], "opened")
        pipeline = Issue.objects.get(sandbox=self.gitlab_env, external_id="4")
        self.assertEqual(pipeline.status, "todo")
        self.assertEqual([label["name"] for label in pipeline.labels], ["ci", "bug"])
        old = Issue.objects.get(sandbox=self.gitlab_env, external_id="3")
        self.assertEqual((old.status, old.body, old.number), ("done", "", 1))

    def test_gitlab_access_errors_are_actionable(self):
        with patch("issues.services.importer.requests.get", return_value=_response({}, 401)):
            res = self.post(self.gitlab_env)
        self.assertEqual(res.json()["code"], "gitlab_not_connected")
        self.connect("gitlab")
        with patch("issues.services.importer.requests.get", return_value=_response({}, 403)):
            res = self.post(self.gitlab_env)
        self.assertEqual((res.status_code, res.json()["code"]), (400, "gitlab_scope_missing"))
        with patch("issues.services.importer.requests.get", return_value=_response({}, 404)):
            self.assertEqual(self.post(self.gitlab_env).json()["code"], "repository_unavailable")

    def test_provider_is_detected_and_can_be_overridden(self):
        self.assertEqual(importer.detect_provider(self.github_env), "github")
        self.assertEqual(importer.detect_provider(self.gitlab_env), "gitlab")
        ssh = self._env("ssh", "git@github.com:acme/ssh-app.git", "acme/ssh-app")
        self.assertEqual(importer._repo_parts(ssh), ("github.com", "acme/ssh-app"))
        bare = Sandbox.objects.create(
            user=self.user, workspace=self.workspace, slug="bare", display_name="bare", filesystem_path="/workspace/bare"
        )
        res = self.post(bare)
        self.assertEqual((res.status_code, res.json()["code"]), (400, "no_repository"))

    def test_invalid_state_is_rejected_before_any_request(self):
        with patch("issues.services.importer.requests.get") as get:
            res = self.post(self.github_env, state="weird")
        self.assertEqual(res.status_code, 400)
        get.assert_not_called()

    def test_import_is_capped_and_reports_truncation(self):
        items = [
            {"number": n, "title": f"Issue {n}", "state": "open", "created_at": f"2026-01-{n:02d}T00:00:00Z"}
            for n in range(9, 4, -1)
        ]
        with patch.object(importer, "MAX_IMPORT", 3), patch(
            "issues.services.importer.requests.get", return_value=_response(items)
        ):
            body = self.post(self.github_env, state="all").json()
        self.assertEqual((body["imported"], body["truncated"]), (3, True))

    def test_non_members_cannot_import(self):
        stranger = APIClient()
        stranger.force_authenticate(user=User.objects.create_user(username="eve", email="e@example.com", password="pw"))
        with patch("issues.services.importer.requests.get") as get:
            res = stranger.post(f"/issues/environments/{self.github_env.uuid}/import/", {}, format="json")
        self.assertEqual(res.status_code, 404)
        get.assert_not_called()
