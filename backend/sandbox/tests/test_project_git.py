from django.test import SimpleTestCase

from sandbox.services.project_git import github_git_setup_command


class GithubGitSetupCommandTests(SimpleTestCase):
    def test_command_stores_credentials_identity_and_upstream(self):
        command = github_git_setup_command(
            "secret-token",
            user_name="octocat",
            user_email="octocat@example.com",
            target_path="/workspace/repo",
            upstream_url="https://github.com/upstream/repo.git",
        )
        self.assertIn("credential.helper", command)
        self.assertIn("/root/.git-credentials", command)
        self.assertIn("user.name octocat", command)
        self.assertIn("user.email octocat@example.com", command)
        self.assertIn("remote add upstream https://github.com/upstream/repo.git", command)
        self.assertNotIn("secret-token", command)

    def test_no_token_produces_no_command(self):
        self.assertEqual(github_git_setup_command(""), "")
