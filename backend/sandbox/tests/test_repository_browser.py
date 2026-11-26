"""Exercise read-only Git browsing and authenticated GitHub PR reads."""
import subprocess
import shutil
import shlex
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from social_django.models import UserSocialAuth
from sandbox.models import Sandbox, Workspace, WorkspaceMembership
from sandbox.services.repository_reader import RepositoryUnavailable, github_repository, read
from sandbox.services.git_service import get_shared_workspace_root


@override_settings(SANDBOX_PROVIDER="docker")
class RepositoryBrowserTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="git-owner", email="git@example.com", password="test123")
        self.workspace = Workspace.objects.create(owner=self.user, name="Git team", slug="git-team")
        WorkspaceMembership.objects.create(workspace=self.workspace, user=self.user, role="owner")
        self.files = Sandbox.objects.create(user=self.user, workspace=self.workspace, slug="files", filesystem_path="/workspace")
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        settings = override_settings(LOCAL_WORKSPACE_ROOT=Path(temp.name))
        settings.enable()
        self.addCleanup(settings.disable)
        self.root = get_shared_workspace_root(self.files)
        self.repo = self.root / "cloned repo"
        self.repo.mkdir()
        self.git("init", "--quiet")
        self.git("config", "user.name", "Test Author")
        self.git("config", "user.email", "test@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/sandbox/sandboxes/{self.files.uuid}"
        # Run the exact runtime script against temporary workspace storage.
        self.runtime = MagicMock()
        def execute(*args, **kwargs):
            if args[:2] == ("bash", "-lc"):
                script = args[2].replace("/workspace", str(self.root))
                result = subprocess.run(["bash", "-lc", script], capture_output=True, timeout=30)
                return MagicMock(stdout=[result.stdout], returncode=result.returncode, wait=MagicMock(return_value=result.returncode))
            import json
            command = shlex.split(args[2])
            payload = json.loads(command[4])
            try:
                output = json.dumps(read(self.root, **payload)).encode()
                code = 0
            except RepositoryUnavailable as error:
                output = json.dumps({"error": str(error), "code": error.code}).encode()
                code = 1
            except Exception as error:
                output = json.dumps({"error": str(error)}).encode()
                code = 1
            return MagicMock(stdout=[output], returncode=code, wait=MagicMock(return_value=code))
        self.runtime.exec.side_effect = execute
        factory = patch("sandbox.services.sandbox_session.get_sandbox_manager")
        self.manager = factory.start()
        self.addCleanup(factory.stop)
        self.manager.return_value.get_or_create.return_value = self.runtime

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout

    def get(self, endpoint, **params):
        return self.client.get(f"{self.url}/{endpoint}/", {"path": "/workspace/cloned repo", **params})

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "First commit")

    def test_discovers_clones_without_creating_projects_or_starting_runtime(self):
        with patch("sandbox.services.sandbox_session.SandboxSessionManager.get_or_create") as start:
            response = self.get("git/repositories")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["repositories"][0]["path"], "/workspace/cloned repo")
        self.assertEqual(Sandbox.objects.count(), 1)
        self.assertFalse((self.root / ".git").exists())
        start.assert_not_called()

    def test_unborn_staged_and_untracked_previews_do_not_mutate_index(self):
        (self.repo / "staged.txt").write_text("staged\n")
        self.git("add", "staged.txt")
        (self.repo / "新 file.txt").write_text("new line\n")
        before = (self.repo / ".git/index").read_bytes()
        status = self.get("git/repository")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()["history"], [])
        self.assertEqual(status.data["total_commits"], 0)
        self.assertFalse(status.data["history_has_next"])
        self.assertIsNone(status.data["history_next_offset"])
        self.assertEqual(self.get("git/history").data["history"], [])
        self.assertEqual(self.get("git/history").data["total_commits"], 0)
        self.assertEqual({f["path"] for f in status.json()["files"]}, {"staged.txt", "新 file.txt"})
        self.assertIn("+new line", self.get("git/file-diff", file="新 file.txt").json()["diff"])
        self.assertIn("+staged", self.get("git/file-diff", file="staged.txt").json()["diff"])
        self.assertEqual((self.repo / ".git/index").read_bytes(), before)
        self.assertEqual(self.git("rev-list", "--all"), "")

    def test_status_history_and_tracked_diff_keep_staging_unchanged(self):
        (self.repo / "hello.py").write_text("old\n")
        self.commit()
        (self.repo / "hello.py").write_text("new\n")
        before = self.git("status", "--porcelain")
        response = self.get("git/repository")
        self.assertEqual(response.json()["history"][0]["subject"], "First commit")
        diff = self.get("git/file-diff", file="hello.py").json()["diff"]
        self.assertIn("-old", diff)
        self.assertIn("+new", diff)
        self.assertEqual(self.git("status", "--porcelain"), before)

    def test_history_scrolls_through_all_commits_using_a_stable_head(self):
        for index in range(45):
            self.git("commit", "--allow-empty", "--quiet", "-m", f"Commit {index}")
        first = self.get("git/repository").data
        self.assertEqual(len(first["history"]), 20)
        self.assertEqual(first["total_commits"], 45)
        self.assertTrue(first["history_has_next"])
        self.assertEqual(first["history_next_offset"], 20)
        # Changes to HEAD between requests must not shift the next page.
        self.git("commit", "--allow-empty", "--quiet", "-m", "New commit")
        self.assertEqual(self.get("git/repository").data["total_commits"], 46)
        second = self.get("git/history", offset=20, head=first["head_commit"])
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(len(second.data["history"]), 20)
        self.assertEqual(second.data["total_commits"], 45)
        self.assertTrue(second.data["has_next"])
        self.assertEqual(second.data["next_offset"], 40)
        third = self.get("git/history", offset=40, head=first["head_commit"]).data
        self.assertEqual(len(third["history"]), 5)
        self.assertEqual(third["total_commits"], 45)
        self.assertFalse(third["has_next"])
        self.assertIsNone(third["next_offset"])
        history = first["history"] + second.data["history"] + third["history"]
        self.assertEqual([item["subject"] for item in history], [f"Commit {index}" for index in reversed(range(45))])
        self.assertEqual(len({item["hash"] for item in history}), 45)

    def test_history_with_exactly_one_page_has_no_more_commits(self):
        for index in range(20):
            self.git("commit", "--allow-empty", "--quiet", "-m", f"Commit {index}")
        response = self.get("git/history")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(len(response.data["history"]), 20)
        self.assertFalse(response.data["has_next"])
        self.assertIsNone(response.data["next_offset"])
        self.assertEqual(self.get("git/history", offset=20).data["history"], [])

    def test_history_rejects_invalid_pagination(self):
        for params in ({"offset": -1}, {"offset": "invalid"}, {"head": "--all"}, {"head": "main"}):
            with self.subTest(params=params):
                self.assertEqual(self.get("git/history", **params).status_code, 400)

    def test_deleted_folder_contents_remain_readable_git_deletions(self):
        folder = self.repo / "nested folder"
        folder.mkdir()
        (folder / "tracked.txt").write_text("tracked content\n")
        self.commit()
        shutil.rmtree(folder)
        status = self.get("git/repository")
        self.assertEqual(status.status_code, 200)
        self.assertEqual([(item["path"], item["status"]) for item in status.data["files"]], [("nested folder/tracked.txt", "deleted")])
        diff = self.get("git/file-diff", file="nested folder/tracked.txt")
        self.assertEqual(diff.status_code, 200)
        self.assertIn("-tracked content", diff.data["diff"])

    def test_removed_repository_is_not_listed_and_returns_a_specific_missing_response(self):
        shutil.rmtree(self.repo)
        self.assertEqual(self.get("git/repositories").data["repositories"], [])
        with patch("sandbox.repository_views.requests.get") as github:
            for endpoint in ("git/repository", "git/history", "git/file-diff", "github/pull-requests", "github/issues"):
                response = self.get(endpoint, file="tracked.txt")
                self.assertEqual(response.status_code, 404, response.data)
                self.assertEqual(response.data["code"], "repository_unavailable")
            github.assert_not_called()
        self.assertEqual(self.post("git/commit", message="Missing").data["code"], "repository_unavailable")
        self.assertFalse(self.repo.exists())

    def test_removed_repository_preserves_missing_response(self):
        shutil.rmtree(self.repo)
        response = self.get("git/repository")
        self.assertEqual(response.status_code, 404, response.data)
        self.assertEqual(response.data["code"], "repository_unavailable")

    def test_discovery_skips_a_repository_removed_during_the_read(self):
        from sandbox.services.repository_reader import describe
        def disappear(path, root):
            shutil.rmtree(path)
            return describe(path, root)
        with patch("sandbox.services.repository_reader.describe", side_effect=disappear):
            response = self.get("git/repositories")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["repositories"], [])

    def test_renames_spaces_and_literal_pathspec_files(self):
        (self.repo / "old name.txt").write_text("content\n")
        self.commit()
        self.git("mv", "old name.txt", "new name.txt")
        data = self.get("git/repository").json()
        self.assertEqual(data["files"][0]["path"], "new name.txt")
        self.assertEqual(data["files"][0]["previous_path"], "old name.txt")
        (self.repo / ":(glob)*").write_text("literal file\n")
        self.assertIn("+literal file", self.get("git/file-diff", file=":(glob)*").json()["diff"])

    def test_path_traversal_metadata_and_symlinks_are_rejected(self):
        for endpoint, params in (("git/repository", {"path": "/workspace/../outside"}), ("git/file-diff", {"file": "../../outside"}), ("git/file-diff", {"file": ".git/config"})):
            self.assertEqual(self.get(endpoint, **params).status_code, 400)
        with TemporaryDirectory() as outside:
            (self.root / "escape").symlink_to(outside, target_is_directory=True)
            self.assertEqual(self.get("git/repository", path="/workspace/escape").status_code, 400)

    def test_other_users_cannot_read_repository_or_request_github(self):
        other = get_user_model().objects.create_user(username="outsider", password="test123")
        self.client.force_authenticate(other)
        with patch("sandbox.repository_views.requests.get") as github:
            self.assertEqual(self.get("git/repositories").status_code, 404)
            self.assertEqual(self.get("github/pull-requests").status_code, 404)
            self.assertEqual(self.get("github/issues").status_code, 404)
            github.assert_not_called()

    def test_github_remote_credentials_are_not_returned(self):
        self.git("remote", "add", "origin", "https://x-access-token:private-token@github.com/acme/app.git")
        for endpoint in ("git/repositories", "git/repository"):
            response = self.get(endpoint)
            self.assertNotIn("private-token", response.content.decode())
            self.assertIn("https://github.com/acme/app", response.content.decode())
        self.assertEqual(github_repository("git@github.com:acme/app.git"), "acme/app")
        self.assertIsNone(github_repository("https://github.com.evil.test/acme/app.git"))

    def test_github_draft_merged_pagination_and_connection(self):
        self.git("remote", "add", "origin", "git@github.com:acme/app.git")
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="test", extra_data={"access_token": "test-token"})
        response = MagicMock(status_code=200, links={"next": {"url": "next"}})
        response.json.return_value = [{"number": 3, "title": "Draft", "state": "open", "draft": True, "user": {"login": "maya"}}, {"number": 2, "title": "Merged", "state": "closed", "merged_at": "2026-10-01T00:00:00Z"}]
        with patch("sandbox.repository_views.requests.get", return_value=response) as github:
            result = self.get("github/pull-requests", state="closed", page=2)
        self.assertEqual(result.status_code, 200)
        self.assertEqual([p["state"] for p in result.json()["pull_requests"]], ["draft", "merged"])
        self.assertTrue(result.json()["has_next"])
        self.assertEqual(github.call_args.kwargs["params"]["page"], 2)
        self.assertEqual(github.call_args.kwargs["headers"]["Authorization"], "Bearer test-token")
        self.assertFalse(github.call_args.kwargs["allow_redirects"])

    def test_public_repositories_and_visible_api_failure(self):
        self.git("remote", "add", "origin", "https://github.com/acme/app.git")
        response = MagicMock(status_code=200, links={})
        response.json.return_value = []
        with patch("sandbox.repository_views.requests.get", return_value=response) as github:
            self.assertEqual(self.get("github/pull-requests").status_code, 200)
            self.assertNotIn("Authorization", github.call_args.kwargs["headers"])
            response.status_code = 403
            self.assertEqual(self.get("github/pull-requests").status_code, 502)

    def test_no_remote_and_invalid_filter_do_not_call_github(self):
        with patch("sandbox.repository_views.requests.get") as github:
            self.assertEqual(self.get("github/pull-requests").json()["pull_requests"], [])
            self.git("remote", "add", "origin", "https://github.com/acme/app.git")
            self.assertEqual(self.get("github/pull-requests", state="bad").status_code, 400)
            github.assert_not_called()

    def test_github_issues_filters_prs_and_handles_labels_and_pagination(self):
        self.git("remote", "add", "origin", "git@github.com:acme/app.git")
        UserSocialAuth.objects.create(user=self.user, provider="github", uid="test-issue", extra_data={"access_token": "issue-token"})
        response = MagicMock(status_code=200, links={"next": {"url": "next"}})
        response.json.return_value = [
            {"number": 10, "title": "A PR", "state": "open", "pull_request": {"url": "..."}, "user": {"login": "maya"}},
            {"number": 11, "title": "A Real Issue", "state": "open", "user": {"login": "alex"}, "comments": 3, "labels": [{"name": "bug", "color": "d73a4a"}]},
            {"number": 12, "title": "Closed Issue", "state": "closed", "user": {"login": "sam"}},
        ]
        with patch("sandbox.repository_views.requests.get", return_value=response) as github:
            result = self.get("github/issues", state="open", page=1)
        self.assertEqual(result.status_code, 200)
        issues = result.json()["issues"]
        self.assertEqual(len(issues), 2)
        self.assertEqual(issues[0]["number"], 11)
        self.assertEqual(issues[0]["labels"][0]["name"], "bug")
        self.assertEqual(issues[0]["comments"], 3)
        self.assertTrue(result.json()["has_next"])
        self.assertEqual(github.call_args.kwargs["headers"]["Authorization"], "Bearer issue-token")

    def test_github_issues_search_api_dict_response_and_closed_filter(self):
        self.git("remote", "add", "origin", "git@github.com:acme/app.git")
        response = MagicMock(status_code=200, links={})
        response.json.return_value = {
            "total_count": 1,
            "items": [
                {"number": 42, "title": "A Closed Issue", "state": "closed", "user": {"login": "dev"}, "comments": 0, "labels": []},
            ],
        }
        with patch("sandbox.repository_views.requests.get", return_value=response) as github:
            result = self.get("github/issues", state="closed", page=1)
        self.assertEqual(result.status_code, 200)
        issues = result.json()["issues"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["number"], 42)
        self.assertEqual(issues[0]["state"], "closed")
        self.assertFalse(result.json()["has_next"])
        self.assertIn("is:closed", github.call_args.kwargs["params"]["q"])
        self.assertIn("is:issue", github.call_args.kwargs["params"]["q"])

    def test_github_issues_no_remote_and_invalid_filter(self):
        with patch("sandbox.repository_views.requests.get") as github:
            self.assertEqual(self.get("github/issues").json()["issues"], [])
            self.git("remote", "add", "origin", "https://github.com/acme/app.git")
            self.assertEqual(self.get("github/issues", state="bad").status_code, 400)
            github.assert_not_called()

    def test_github_issue_comments(self):
        self.git("remote", "add", "origin", "git@github.com:acme/app.git")
        response = MagicMock(status_code=200)
        response.json.return_value = [
            {
                "id": 101,
                "html_url": "https://github.com/acme/app/issues/42#issuecomment-101",
                "user": {"login": "sarah", "avatar_url": "https://avatars.example.com/sarah"},
                "created_at": "2026-10-01T12:00:00Z",
                "updated_at": "2026-10-01T12:00:00Z",
                "body": "Reproduced on staging.",
            }
        ]
        with patch("sandbox.repository_views.requests.get", return_value=response) as github:
            result = self.get("github/issues/42/comments")
        self.assertEqual(result.status_code, 200)
        comments = result.json()["comments"]
        self.assertEqual(len(comments), 1)
        self.assertEqual(comments[0]["author"], "sarah")
        self.assertEqual(comments[0]["author_avatar"], "https://avatars.example.com/sarah")
        self.assertEqual(comments[0]["body"], "Reproduced on staging.")
        self.assertIn("issues/42/comments", github.call_args.args[0])

    def test_github_pull_request_details_and_resources(self):
        self.git("remote", "add", "origin", "git@github.com:acme/app.git")
        # 1. Detail
        pr_mock = MagicMock(status_code=200)
        pr_mock.json.return_value = {
            "number": 7,
            "title": "Add feature",
            "state": "open",
            "body": "PR description",
            "user": {"login": "maya", "avatar_url": "https://avatars.example.com/maya"},
            "head": {"ref": "feature-branch", "sha": "abc1234"},
            "base": {"ref": "main", "sha": "def5678"},
            "additions": 15,
            "deletions": 3,
            "changed_files": 2,
            "commits": 1,
            "labels": [{"name": "enhancement", "color": "a2eeef"}],
            "assignees": [{"login": "maya", "avatar_url": "https://avatars.example.com/maya"}],
            "requested_reviewers": [{"login": "sarah", "avatar_url": "https://avatars.example.com/sarah"}],
        }
        with patch("sandbox.repository_views.requests.get", return_value=pr_mock):
            res = self.get("github/pull-requests/7")
        self.assertEqual(res.status_code, 200)
        pr_data = res.json()["pull_request"]
        self.assertEqual(pr_data["number"], 7)
        self.assertEqual(pr_data["author"], "maya")
        self.assertEqual(pr_data["additions"], 15)
        self.assertEqual(pr_data["deletions"], 3)
        self.assertEqual(pr_data["changed_files"], 2)

        # 2. Files
        files_mock = MagicMock(status_code=200)
        files_mock.json.return_value = [
            {
                "sha": "f1",
                "filename": "src/app.py",
                "status": "modified",
                "additions": 10,
                "deletions": 2,
                "changes": 12,
                "patch": "@@ -1,2 +1,3 @@\n+print('hello')",
            }
        ]
        with patch("sandbox.repository_views.requests.get", return_value=files_mock):
            res_files = self.get("github/pull-requests/7/files")
        self.assertEqual(res_files.status_code, 200)
        self.assertEqual(len(res_files.json()["files"]), 1)
        self.assertEqual(res_files.json()["files"][0]["filename"], "src/app.py")

        # 3. Commits
        commits_mock = MagicMock(status_code=200)
        commits_mock.json.return_value = [
            {
                "sha": "abc1234567890",
                "commit": {"message": "feat: init", "author": {"name": "Maya", "date": "2026-10-31T12:00:00Z"}},
                "author": {"login": "maya", "avatar_url": "https://avatars.example.com/maya"},
                "html_url": "https://github.com/acme/app/commit/abc1234567890",
            }
        ]
        with patch("sandbox.repository_views.requests.get", return_value=commits_mock):
            res_commits = self.get("github/pull-requests/7/commits")
        self.assertEqual(res_commits.status_code, 200)
        self.assertEqual(len(res_commits.json()["commits"]), 1)
        self.assertEqual(res_commits.json()["commits"][0]["message"], "feat: init")

        # 4. Comments
        comments_mock = MagicMock(status_code=200)
        comments_mock.json.return_value = [
            {
                "id": 999,
                "user": {"login": "sarah", "avatar_url": "https://avatars.example.com/sarah"},
                "created_at": "2026-10-31T12:30:00Z",
                "body": "Looks great!",
            }
        ]
        with patch("sandbox.repository_views.requests.get", return_value=comments_mock):
            res_comments = self.get("github/pull-requests/7/comments")
        self.assertEqual(res_comments.status_code, 200)
        self.assertEqual(len(res_comments.json()["comments"]), 2)  # called both issue and review comments

        # 5. Checks
        checks_mock = MagicMock(status_code=200)
        checks_mock.json.return_value = {
            "total_count": 1,
            "check_runs": [
                {
                    "id": 55,
                    "name": "build",
                    "status": "completed",
                    "conclusion": "success",
                    "html_url": "https://github.com/acme/app/actions/runs/55",
                }
            ],
        }
        with patch("sandbox.repository_views.requests.get", return_value=checks_mock):
            res_checks = self.get("github/pull-requests/7/checks", ref="abc1234")
        self.assertEqual(res_checks.status_code, 200)
        self.assertEqual(len(res_checks.json()["checks"]), 1)
        self.assertEqual(res_checks.json()["checks"][0]["conclusion"], "success")

    def test_browser_reuses_workspace_runtime(self):
        from sandbox.services.repository_browser import read_repository
        process = MagicMock(stdout=[b'{"repositories": []}'])
        runtime = MagicMock()
        runtime.exec.return_value = process
        with patch("sandbox.services.sandbox_service.SandboxBootstrapService.ensure_workspace_sandbox", return_value=self.files) as filesystem, patch("sandbox.services.sandbox_session.get_sandbox_manager") as manager:
            manager.return_value.get_or_create.return_value = runtime
            self.assertEqual(read_repository(self.files, "list"), {"repositories": []})
            filesystem.assert_called_once_with(self.workspace)
            manager.return_value.get_or_create.assert_called_once_with(self.files)

    def test_merge_conflicts_are_identified_without_marking_them_staged(self):
        (self.repo / "conflict.txt").write_text("base\n")
        self.commit()
        original = self.git("branch", "--show-current").strip()
        self.git("checkout", "-b", "feature")
        (self.repo / "conflict.txt").write_text("feature\n")
        self.commit()
        self.git("checkout", original)
        (self.repo / "conflict.txt").write_text("main\n")
        self.commit()
        subprocess.run(["git", "merge", "feature"], cwd=self.repo, capture_output=True)
        change = self.get("git/repository").json()["files"][0]
        self.assertEqual(change["status"], "conflict")
        self.assertFalse(change["staged"])

    def post(self, endpoint, **data):
        return self.client.post(f"{self.url}/{endpoint}/", {"path": "/workspace/cloned repo", **data}, format="json")

    def test_commit_only_selected_repository_and_authenticated_author(self):
        sibling = self.root / "other"
        sibling.mkdir()
        subprocess.run(["git", "init", "--quiet", str(sibling)], check=True)
        (sibling / "unrelated.txt").write_text("other project\n")
        (self.repo / "new file.txt").write_text("selected project\n")
        result = self.post("git/commit", message="Save selected project")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["files"], [])
        self.assertEqual(result.data["history"][0]["subject"], "Save selected project")
        self.assertEqual(result.data["history"][0]["author"], "git-owner")
        self.assertEqual(self.git("show", "HEAD:new file.txt"), "selected project\n")
        sibling_status = subprocess.run(["git", "status", "--porcelain"], cwd=sibling, capture_output=True, text=True, check=True).stdout
        self.assertIn("?? unrelated.txt", sibling_status)

    def test_status_clean_when_only_sibling_changed(self):
        (self.repo / "tracked.txt").write_text("base\n")
        self.commit()
        sibling = self.root / "other"
        sibling.mkdir()
        (sibling / "unrelated.txt").write_text("changed\n")
        self.assertEqual(self.get("git/repository").data["files"], [])

    def test_commit_message_and_empty_tree_validation(self):
        (self.repo / "new.txt").write_text("new\n")
        for message in ("", "  ", "x" * 2001):
            self.assertEqual(self.post("git/commit", message=message).status_code, 400)
        self.assertIn("?? new.txt", self.git("status", "--porcelain"))
        self.assertEqual(self.post("git/commit", message="First").status_code, 200)
        self.assertEqual(self.post("git/commit", message="Empty").status_code, 400)

    def test_stage_selected_literal_file_and_unstage_before_first_commit(self):
        (self.repo / ":(glob)*").write_text("literal file\n")
        (self.repo / "other.txt").write_text("keep unstaged\n")
        staged = self.post("git/stage", files=[":(glob)*"])
        self.assertEqual(staged.status_code, 200, staged.data)
        self.assertEqual({item["path"] for item in staged.data["files"] if item["staged"]}, {":(glob)*"})
        unstaged = self.post("git/unstage", files=[":(glob)*"])
        self.assertEqual(unstaged.status_code, 200, unstaged.data)
        self.assertFalse(any(item["staged"] for item in unstaged.data["files"]))
        self.assertEqual((self.repo / ":(glob)*").read_text(), "literal file\n")

    def test_staged_commit_keeps_later_edits_and_other_files_uncommitted(self):
        (self.repo / "tracked.txt").write_text("base\n")
        self.commit()
        (self.repo / "tracked.txt").write_text("staged version\n")
        self.assertEqual(self.post("git/stage", files=["tracked.txt"]).status_code, 200)
        (self.repo / "tracked.txt").write_text("later working version\n")
        (self.repo / "other.txt").write_text("not selected\n")
        staged_diff = self.get("git/file-diff", file="tracked.txt", mode="staged")
        working_diff = self.get("git/file-diff", file="tracked.txt", mode="unstaged")
        self.assertIn("+staged version", staged_diff.data["diff"])
        self.assertNotIn("later working", staged_diff.data["diff"])
        self.assertIn("-staged version", working_diff.data["diff"])
        self.assertIn("+later working version", working_diff.data["diff"])
        result = self.post("git/commit", message="Selected changes", staged_only=True)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(self.git("show", "HEAD:tracked.txt"), "staged version\n")
        self.assertEqual({item["path"] for item in result.data["files"]}, {"tracked.txt", "other.txt"})
        self.assertEqual((self.repo / "tracked.txt").read_text(), "later working version\n")

    def test_staged_only_commit_requires_staged_changes(self):
        (self.repo / "new.txt").write_text("untracked\n")
        response = self.post("git/commit", message="No staged changes", staged_only=True)
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn("Stage changes", response.data["error"])
        self.assertEqual(self.git("ls-files"), "")

    def test_stage_and_unstage_all_preserve_modified_and_deleted_files(self):
        (self.repo / "modified.txt").write_text("base\n")
        (self.repo / "deleted.txt").write_text("delete me\n")
        self.commit()
        (self.repo / "modified.txt").write_text("changed\n")
        (self.repo / "deleted.txt").unlink()
        (self.repo / "new.txt").write_text("new\n")
        staged = self.post("git/stage", all=True)
        self.assertEqual(staged.status_code, 200, staged.data)
        self.assertTrue(all(item["staged"] for item in staged.data["files"]))
        unstaged = self.post("git/unstage", all=True)
        self.assertEqual(unstaged.status_code, 200, unstaged.data)
        self.assertFalse(any(item["staged"] for item in unstaged.data["files"]))
        self.assertEqual((self.repo / "modified.txt").read_text(), "changed\n")
        self.assertFalse((self.repo / "deleted.txt").exists())
        self.assertEqual((self.repo / "new.txt").read_text(), "new\n")

    def test_unstage_rename_restores_both_index_paths_without_moving_files(self):
        (self.repo / "old name.txt").write_text("contents\n")
        self.commit()
        self.git("mv", "old name.txt", "new name.txt")
        result = self.post("git/unstage", files=["new name.txt"])
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(self.git("diff", "--cached"), "")
        self.assertFalse((self.repo / "old name.txt").exists())
        self.assertEqual((self.repo / "new name.txt").read_text(), "contents\n")

    def test_staging_rejects_invalid_paths_and_other_users(self):
        (self.repo / "new.txt").write_text("new\n")
        for endpoint in ("git/stage", "git/unstage"):
            for files in ([], "new.txt", [None], ["../../escape"], [".git/config"], ["missing"], ["new.txt", "../escape"]):
                response = self.post(endpoint, files=files)
                self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(self.git("ls-files"), "")
        other = get_user_model().objects.create_user(username="staging-outsider")
        self.client.force_authenticate(other)
        for endpoint in ("git/stage", "git/unstage"):
            self.assertEqual(self.post(endpoint, all=True).status_code, 404)

    def test_status_reports_local_upstream_distance(self):
        (self.repo / "base.txt").write_text("base\n")
        self.commit()
        self.git("remote", "add", "origin", "https://github.com/example/test.git")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("branch", "--set-upstream-to=origin/main")
        (self.repo / "base.txt").write_text("ahead\n")
        self.commit()
        status = self.get("git/repository")
        self.assertEqual(status.status_code, 200, status.data)
        self.assertEqual((status.data["upstream"], status.data["ahead"], status.data["behind"]), ("origin/main", 1, 0))

    def test_create_and_switch_branch(self):
        (self.repo / "base.txt").write_text("base\n")
        self.commit()
        original = self.git("branch", "--show-current").strip()
        result = self.post("git/switch", branch="feature/ui", create=True)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["branch"], "feature/ui")
        self.assertIn({"name": "feature/ui", "remote": False}, result.data["branches"])
        result = self.post("git/switch", branch=original)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.data["branch"], original)

    def test_branch_switch_refuses_overwriting_changes(self):
        (self.repo / "base.txt").write_text("base\n")
        self.commit()
        original = self.git("branch", "--show-current").strip()
        self.git("checkout", "-b", "feature")
        (self.repo / "base.txt").write_text("feature\n")
        self.commit()
        self.git("checkout", original)
        (self.repo / "base.txt").write_text("unsaved\n")
        result = self.post("git/switch", branch="feature")
        self.assertEqual(result.status_code, 400)
        self.assertIn("Commit your changes", result.data["error"])
        self.assertEqual((self.repo / "base.txt").read_text(), "unsaved\n")
        self.assertEqual(self.git("branch", "--show-current").strip(), original)

    def test_invalid_branches_and_unauthorized_writes(self):
        (self.repo / "base.txt").write_text("base\n")
        self.commit()
        for branch in ("--force", "../escape", "missing", "bad name"):
            self.assertEqual(self.post("git/switch", branch=branch).status_code, 400)
        self.assertEqual(self.post("git/commit", path="/workspace/../outside", message="Bad path").status_code, 400)
        other = get_user_model().objects.create_user(username="git-outsider")
        self.client.force_authenticate(other)
        self.assertEqual(self.post("git/commit", message="Unauthorized").status_code, 404)
        self.assertEqual(self.post("git/switch", branch="main").status_code, 404)

    def test_switch_remote_tracking_branch(self):
        (self.repo / "base.txt").write_text("base\n")
        self.commit()
        self.git("remote", "add", "origin", "https://github.com/example/test.git")
        self.git("update-ref", "refs/remotes/origin/feature", "HEAD")
        result = self.post("git/switch", branch="origin/feature")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["branch"], "feature")
        self.assertEqual(self.git("rev-parse", "--abbrev-ref", "@{upstream}").strip(), "origin/feature")

    def test_remote_head_alias_is_not_a_branch_and_cannot_be_selected(self):
        (self.repo / "base.txt").write_text("base")
        self.commit()
        original = self.git("branch", "--show-current").strip()
        self.git("remote", "add", "origin", "https://github.com/example/test.git")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        names = {branch["name"] for branch in self.get("git/repository").data["branches"]}
        self.assertIn("origin/main", names)
        self.assertNotIn("origin", names)
        self.assertNotIn("origin/HEAD", names)
        for alias in ("origin", "origin/HEAD"):
            result = self.post("git/switch", branch=alias)
            self.assertEqual(result.status_code, 400, result.data)
            self.assertIn("no longer exists", result.data["error"])
        self.assertEqual(self.git("branch", "--show-current").strip(), original)
        result = self.post("git/switch", branch="origin/main")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["branch"], "main")

    def test_ambiguous_local_and_remote_refs_keep_actual_branch_names(self):
        (self.repo / "base.txt").write_text("base")
        self.commit()
        self.git("remote", "add", "origin", "https://github.com/example/test.git")
        self.git("update-ref", "refs/remotes/origin/feature", "HEAD")
        self.git("branch", "origin/feature")
        branches = self.get("git/repository").data["branches"]
        self.assertIn({"name": "origin/feature", "remote": False}, branches)
        self.assertIn({"name": "origin/feature", "remote": True}, branches)
        result = self.post("git/switch", branch="origin/feature")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["branch"], "origin/feature")

    def test_invalid_runtime_response_does_not_expose_json_parser_error(self):
        for output in (b"", b"not json", b"[]"):
            with self.subTest(output=output):
                self.runtime.exec.side_effect = None
                self.runtime.exec.return_value = MagicMock(stdout=[output], returncode=1)
                result = self.post("git/switch", branch="feature", create=True)
                self.assertEqual(result.status_code, 503, result.data)
                self.assertEqual(result.data["error"], "The workspace is temporarily unavailable.")

    def test_local_writes_use_workspace_runtime(self):
        result = self.post("git/switch", branch="feature", create=True)
        self.assertEqual(result.status_code, 200, result.data)
        self.manager.return_value.get_or_create.assert_called_once()
        self.assertEqual(self.manager.return_value.get_or_create.call_args.args[0].uuid, self.files.uuid)
        self.assertEqual(result.data["branch"], "feature")

    def test_selecting_current_unborn_branch_is_a_noop(self):
        branch = self.git("branch", "--show-current").strip()
        result = self.post("git/switch", branch=branch)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["branch"], branch)
        self.assertEqual(result.data["head_commit"], "")

    def test_switch_remote_branch_with_existing_tracking_branch(self):
        (self.repo / "base.txt").write_text("base")
        self.commit()
        original = self.git("branch", "--show-current").strip()
        self.git("remote", "add", "origin", "https://github.com/example/test.git")
        self.git("update-ref", "refs/remotes/origin/feature", "HEAD")
        self.assertEqual(self.post("git/switch", branch="origin/feature").status_code, 200)
        self.git("switch", original)
        result = self.post("git/switch", branch="origin/feature")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["branch"], "feature")

    def test_real_index_lock_is_reported_and_not_deleted(self):
        (self.repo / "base.txt").write_text("base")
        self.commit()
        (self.repo / ".git/index.lock").write_text("active lock")
        (self.repo / "new.txt").write_text("new")
        result = self.post("git/commit", message="Locked commit")
        self.assertEqual(result.status_code, 400)
        self.assertIn("repository lock", result.data["error"])
        self.assertEqual((self.repo / ".git/index.lock").read_text(), "active lock")

    def test_new_project_creates_main_repository_and_existing_requires_git(self):
        url = "/sandbox/sandbox-tools/list/"
        payload = {"action": "create", "workspace_uuid": str(self.workspace.uuid)}
        result = self.client.post(url, {**payload, "source": "new", "filesystem_path": "/workspace/new-app"}, format="json")
        self.assertEqual(result.status_code, 201, result.data)
        output = subprocess.run(["git", "branch", "--show-current"], cwd=self.root / "new-app", capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(output, "main")
        (self.root / "plain-folder").mkdir()
        result = self.client.post(url, {**payload, "source": "existing", "filesystem_path": "/workspace/plain-folder"}, format="json")
        self.assertEqual(result.status_code, 400, result.data)
        self.assertFalse((self.root / "plain-folder/.git").exists())
        result = self.client.post(url, {**payload, "source": "new", "filesystem_path": "/workspace/plain-folder"}, format="json")
        self.assertEqual(result.status_code, 400)
        result = self.client.post(url, {**payload, "source": "existing", "filesystem_path": "/workspace/cloned repo"}, format="json")
        self.assertEqual(result.status_code, 201, result.data)
        self.assertEqual(Sandbox.objects.filter(workspace=self.workspace).count(), 3)

    def test_github_issue_detail_returns_issue_and_rejects_pull_requests(self):
        with patch("sandbox.repository_views.requests.get") as github:
            no_remote = self.get("github/issues/15")
            self.assertEqual(no_remote.status_code, 200)
            self.assertEqual(no_remote.json(), {"repository": None, "issue": None})
            github.assert_not_called()

        self.git("remote", "add", "origin", "git@github.com:acme/app.git")

        issue_response = MagicMock(status_code=200)
        issue_response.json.return_value = {
            "number": 15,
            "title": "Fix race condition",
            "state": "open",
            "state_reason": None,
            "body": "Details here",
            "user": {"login": "alex", "avatar_url": "https://avatars.example.com/alex"},
            "comments": 2,
            "labels": [{"name": "bug", "color": "d73a4a"}],
            "assignees": [{"login": "maya", "avatar_url": "https://avatars.example.com/maya"}],
            "milestone": {"title": "v1.2"},
            "html_url": "https://github.com/acme/app/issues/15",
            "created_at": "2026-10-01T10:00:00Z",
            "updated_at": "2026-10-02T10:00:00Z",
            "closed_at": None,
        }
        with patch("sandbox.repository_views.requests.get", return_value=issue_response) as github:
            res = self.get("github/issues/15")
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.json()["repository"], "acme/app")
        self.assertEqual(res.json()["issue"]["number"], 15)
        self.assertEqual(res.json()["issue"]["title"], "Fix race condition")
        self.assertEqual(res.json()["issue"]["milestone"]["title"], "v1.2")
        self.assertIn("repos/acme/app/issues/15", github.call_args.args[0])

        pr_item_response = MagicMock(status_code=200)
        pr_item_response.json.return_value = {
            "number": 16,
            "title": "A PR with same namespace",
            "state": "open",
            "pull_request": {"url": "https://api.github.com/repos/acme/app/pulls/16"},
            "user": {"login": "maya"},
        }
        with patch("sandbox.repository_views.requests.get", return_value=pr_item_response):
            pr_res = self.get("github/issues/16")
        self.assertEqual(pr_res.status_code, 404)


    def _chat(self):
        from chat.models import Conversation
        conversation = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.project.conversations.add(conversation)
        return conversation

    def _chat_branch(self, conversation, branch, create=False, method="post", path="/workspace/cloned repo"):
        # The branch picker talks to the workspace Files sandbox and names the repository by path.
        url = f"{self.url}/git/worktree/"
        payload = {"conversation_id": str(conversation.uuid), "path": path, "branch": branch, "create": create}
        if method == "get":
            return self.client.get(url, payload)
        return getattr(self.client, method)(url, payload, format="json")

    def _start_project_with_commit(self):
        self.project = Sandbox.objects.create(
            user=self.user, workspace=self.workspace, slug="cloned-repo", display_name="Cloned repo", filesystem_path="/workspace/cloned repo",
        )
        (self.repo / "base.txt").write_text("base\n")
        self.commit()
        return self.git("branch", "--show-current").strip()

    def test_each_chat_gets_its_own_branch_checkout(self):
        original = self._start_project_with_commit()
        first, second = self._chat(), self._chat()
        a = self._chat_branch(first, "feature-a", create=True)
        b = self._chat_branch(second, "feature-b", create=True)
        self.assertEqual((a.status_code, b.status_code), (200, 200), (a.data, b.data))
        self.assertEqual((a.data["branch"], b.data["branch"]), ("feature-a", "feature-b"))
        self.assertNotEqual(a.data["worktree_path"], b.data["worktree_path"])
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.worktree_path, a.data["worktree_path"])
        # Work in one chat never appears in the other chat or the project folder.
        folder_a = self.root / first.worktree_path.removeprefix("/workspace/")
        folder_b = self.root / second.worktree_path.removeprefix("/workspace/")
        (folder_a / "only-a.txt").write_text("a\n")
        self.assertFalse((folder_b / "only-a.txt").exists())
        self.assertFalse((self.repo / "only-a.txt").exists())
        self.assertEqual(self.git("branch", "--show-current").strip(), original)
        # Switching branches in one chat leaves the other chat's checkout untouched.
        self.git("branch", "feature-c")
        subprocess.run(["git", "switch", "feature-c"], cwd=folder_a, check=True, capture_output=True)
        self.assertEqual(subprocess.run(["git", "branch", "--show-current"], cwd=folder_b, capture_output=True, text=True).stdout.strip(), "feature-b")

    def test_two_chats_cannot_share_one_branch(self):
        self._start_project_with_commit()
        first, second = self._chat(), self._chat()
        self.assertEqual(self._chat_branch(first, "shared", create=True).status_code, 200)
        clash = self._chat_branch(second, "shared")
        self.assertEqual(clash.status_code, 400)
        self.assertIn("already checked out", clash.data["error"])
        second.refresh_from_db()
        self.assertEqual(second.worktree_path, "")

    def test_choosing_the_project_branch_keeps_chat_on_project_folder(self):
        original = self._start_project_with_commit()
        chat = self._chat()
        self.assertEqual(self._chat_branch(chat, "feature", create=True).status_code, 200)
        back = self._chat_branch(chat, original)
        self.assertEqual(back.status_code, 200, back.data)
        self.assertEqual(back.data["worktree_path"], "")
        chat.refresh_from_db()
        self.assertEqual(chat.worktree_path, "")
        self.assertEqual(self.git("worktree", "list", "--porcelain").count("worktree "), 1)

    def test_leaving_a_branch_refuses_to_drop_unsaved_work(self):
        self._start_project_with_commit()
        chat = self._chat()
        attached = self._chat_branch(chat, "feature", create=True)
        folder = self.root / attached.data["worktree_path"].removeprefix("/workspace/")
        (folder / "wip.txt").write_text("unsaved\n")
        refused = self._chat_branch(chat, "", method="delete")
        self.assertEqual(refused.status_code, 400)
        self.assertIn("uncommitted", refused.data["error"])
        self.assertTrue((folder / "wip.txt").exists())
        (folder / "wip.txt").unlink()
        released = self._chat_branch(chat, "", method="delete")
        self.assertEqual(released.status_code, 200, released.data)
        self.assertFalse(folder.exists())
        chat.refresh_from_db()
        self.assertEqual(chat.worktree_path, "")

    def test_chat_checkouts_are_not_listed_as_projects(self):
        self._start_project_with_commit()
        self.assertEqual(self._chat_branch(self._chat(), "feature", create=True).status_code, 200)
        listed = self.get("git/repositories").json()["repositories"]
        self.assertEqual([item["path"] for item in listed], ["/workspace/cloned repo"])

    def test_branch_requires_a_chat_linked_to_the_project(self):
        from chat.models import Conversation
        self._start_project_with_commit()
        loose = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.assertEqual(self._chat_branch(loose, "feature", create=True).status_code, 404)
        other = get_user_model().objects.create_user(username="worktree-outsider")
        self.client.force_authenticate(other)
        self.assertEqual(self._chat_branch(self._chat(), "feature", create=True).status_code, 404)

    def test_agent_tools_run_in_the_chat_checkout_and_ignore_model_supplied_roots(self):
        from chat.builtin_tools import execute_builtin_tool_stream
        self._start_project_with_commit()
        chat = self._chat()
        attached = self._chat_branch(chat, "feature", create=True)
        chat.refresh_from_db()
        manager = MagicMock()
        manager.execute_tool.return_value = {"ok": True}
        with patch("sandbox.services.sandbox_session.get_sandbox_manager", return_value=manager):
            list(execute_builtin_tool_stream(self.user, "file_read", {"path": "base.txt", "_workspace_root": "/workspace/evil"}, conversation=chat, stream_output=False))
        self.assertEqual(manager.execute_tool.call_args.kwargs["workspace_root"], attached.data["worktree_path"])
        plain = self._chat()
        manager.reset_mock()
        with patch("sandbox.services.sandbox_session.get_sandbox_manager", return_value=manager):
            list(execute_builtin_tool_stream(self.user, "file_read", {"path": "base.txt", "_workspace_root": "/workspace/evil"}, conversation=plain, stream_output=False))
        self.assertNotIn("workspace_root", manager.execute_tool.call_args.kwargs)

    def test_chat_reports_the_checkout_it_works_in(self):
        original = self._start_project_with_commit()
        chat = self._chat()
        before = self._chat_branch(chat, "", method="get")
        self.assertEqual((before.status_code, before.data["branch"], before.data["worktree_path"]), (200, original, ""))
        attached = self._chat_branch(chat, "feature", create=True)
        after = self._chat_branch(chat, "", method="get")
        self.assertEqual((after.data["branch"], after.data["worktree_path"]), ("feature", attached.data["worktree_path"]))
        self.assertEqual(self.git("branch", "--show-current").strip(), original)

    def test_branch_request_must_name_the_chats_own_project(self):
        self._start_project_with_commit()
        chat = self._chat()
        wrong = self._chat_branch(chat, "feature", create=True, path="/workspace/other")
        self.assertEqual(wrong.status_code, 400)
        chat.refresh_from_db()
        self.assertEqual(chat.worktree_path, "")
