"""API tests for native environment-scoped issues."""
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from chat.models import Conversation
from issues.models import Issue, IssueComment
from sandbox.models import Sandbox, Workspace, WorkspaceMembership

User = get_user_model()


def _make_env(owner, slug="repo", workspace=None):
    if workspace is None:
        workspace = Workspace.objects.create(name=f"WS {slug}", slug=f"ws-{slug}", owner=owner)
        WorkspaceMembership.objects.create(
            workspace=workspace, user=owner, role=WorkspaceMembership.ROLE_OWNER
        )
    env = Sandbox.objects.create(
        user=owner,
        workspace=workspace,
        slug=slug,
        display_name=slug,
        filesystem_path=f"/workspace/{slug}",
        repo_full_name=f"acme/{slug}",
    )
    return workspace, env


@override_settings(SANDBOX_PROVIDER="docker")
class IssueApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="owner", email="o@example.com", password="pw")
        self.workspace, self.env = _make_env(self.user, "alpha")
        _, self.env2 = _make_env(self.user, "beta", self.workspace)
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def url(self, env=None, number=None, suffix=""):
        env = env or self.env
        base = f"/issues/environments/{env.uuid}/"
        if number is not None:
            base += f"{number}/"
        return base + suffix

    def create(self, **payload):
        payload.setdefault("title", "Fix login")
        return self.client.post(self.url(), payload, format="json")

    def test_create_numbers_per_environment(self):
        first = self.create(title="One").json()["issue"]
        second = self.create(title="Two").json()["issue"]
        other = self.client.post(self.url(self.env2), {"title": "Other"}, format="json").json()["issue"]
        self.assertEqual((first["number"], second["number"], other["number"]), (1, 2, 1))
        self.assertEqual(first["status"], "todo")
        self.assertEqual(first["state"], "open")
        self.assertEqual(first["creator"], {"type": "user", "name": "owner"})

    def test_create_validates_input(self):
        self.assertEqual(self.create(title="   ").status_code, 400)
        self.assertEqual(self.create(title="x" * 301).status_code, 400)
        self.assertEqual(self.create(priority="bogus").status_code, 400)
        self.assertEqual(self.create(status="bogus").status_code, 400)
        self.assertEqual(self.create(labels="bug").status_code, 400)

    def test_labels_are_normalized_and_deduped(self):
        issue = self.create(labels=["Bug", {"name": "bug", "color": "#ff0000"}, {"name": "UI", "color": "zzz"}]).json()["issue"]
        self.assertEqual(issue["labels"], [{"name": "Bug", "color": ""}, {"name": "UI", "color": ""}])

    def test_list_filters_and_search(self):
        a = self.create(title="Crash on save").json()["issue"]
        b = self.create(title="Typo in docs").json()["issue"]
        self.client.patch(self.url(number=b["number"]), {"status": "done"}, format="json")
        open_rows = self.client.get(self.url(), {"state": "open"}).json()["issues"]
        closed_rows = self.client.get(self.url(), {"state": "closed"}).json()["issues"]
        self.assertEqual([r["number"] for r in open_rows], [a["number"]])
        self.assertEqual([r["number"] for r in closed_rows], [b["number"]])
        found = self.client.get(self.url(), {"state": "all", "q": "typo"}).json()["issues"]
        self.assertEqual([r["number"] for r in found], [b["number"]])
        by_number = self.client.get(self.url(), {"state": "all", "q": f"#{a['number']}"}).json()["issues"]
        self.assertEqual([r["number"] for r in by_number], [a["number"]])
        self.assertEqual(self.client.get(self.url(), {"state": "weird"}).status_code, 400)

    def test_list_reports_open_and_closed_totals_regardless_of_filter_or_search(self):
        for title in ("a", "b", "c"):
            self.create(title=title)
        self.client.patch(self.url(number=3), {"status": "done"}, format="json")
        self.client.patch(self.url(number=2), {"status": "cancelled"}, format="json")
        other = self.client.post(self.url(self.env2), {"title": "elsewhere"}, format="json")
        self.assertEqual(other.status_code, 201)
        for params in ({"state": "open"}, {"state": "closed"}, {"state": "all", "q": "a"}):
            counts = self.client.get(self.url(), params).json()["counts"]
            self.assertEqual(counts, {"open": 1, "closed": 2}, params)

    def test_pagination_reports_has_next(self):
        for i in range(3):
            self.create(title=f"Issue {i}")
        page = self.client.get(self.url(), {"per_page": 2}).json()
        self.assertEqual(len(page["issues"]), 2)
        self.assertTrue(page["has_next"])
        last = self.client.get(self.url(), {"per_page": 2, "page": 2}).json()
        self.assertEqual(len(last["issues"]), 1)
        self.assertFalse(last["has_next"])

    def test_status_transition_sets_and_clears_closed_at(self):
        number = self.create().json()["issue"]["number"]
        closed = self.client.patch(self.url(number=number), {"status": "done"}, format="json").json()["issue"]
        self.assertEqual(closed["state"], "closed")
        self.assertIsNotNone(closed["closed_at"])
        reopened = self.client.patch(self.url(number=number), {"status": "todo"}, format="json").json()["issue"]
        self.assertEqual(reopened["state"], "open")
        self.assertIsNone(reopened["closed_at"])

    def test_patch_updates_fields(self):
        number = self.create().json()["issue"]["number"]
        issue = self.client.patch(
            self.url(number=number),
            {"title": "New title", "body": "details", "priority": "high", "labels": ["bug"]},
            format="json",
        ).json()["issue"]
        self.assertEqual(issue["title"], "New title")
        self.assertEqual(issue["body"], "details")
        self.assertEqual(issue["priority"], "high")
        self.assertEqual(issue["labels"][0]["name"], "bug")

    def test_comments(self):
        number = self.create().json()["issue"]["number"]
        self.assertEqual(
            self.client.post(self.url(number=number, suffix="comments/"), {"body": " "}, format="json").status_code, 400
        )
        created = self.client.post(
            self.url(number=number, suffix="comments/"), {"body": "Looks good"}, format="json"
        )
        self.assertEqual(created.status_code, 201)
        listed = self.client.get(self.url(number=number, suffix="comments/")).json()["comments"]
        self.assertEqual([c["body"] for c in listed], ["Looks good"])
        self.assertEqual(listed[0]["author"], "owner")
        issue = self.client.get(self.url(number=number)).json()["issue"]
        self.assertEqual(issue["comments"], 1)

    def test_non_member_gets_404_everywhere(self):
        number = self.create().json()["issue"]["number"]
        stranger = APIClient()
        stranger.force_authenticate(user=User.objects.create_user(username="eve", email="e@example.com", password="pw"))
        self.assertEqual(stranger.get(self.url()).status_code, 404)
        self.assertEqual(stranger.post(self.url(), {"title": "x"}, format="json").status_code, 404)
        self.assertEqual(stranger.get(self.url(number=number)).status_code, 404)
        self.assertEqual(stranger.patch(self.url(number=number), {"title": "x"}, format="json").status_code, 404)
        self.assertEqual(stranger.delete(self.url(number=number)).status_code, 404)

    def test_issue_from_other_environment_is_not_reachable(self):
        number = self.create().json()["issue"]["number"]
        self.assertEqual(self.client.get(self.url(self.env2, number)).status_code, 404)

    def test_delete_requires_author_or_admin(self):
        member = User.objects.create_user(username="mem", email="m@example.com", password="pw")
        WorkspaceMembership.objects.create(
            workspace=self.workspace, user=member, role=WorkspaceMembership.ROLE_MEMBER
        )
        member_client = APIClient()
        member_client.force_authenticate(user=member)
        number = self.create().json()["issue"]["number"]  # authored by owner
        self.assertEqual(member_client.delete(self.url(number=number)).status_code, 403)
        own = member_client.post(self.url(), {"title": "mine"}, format="json").json()["issue"]["number"]
        self.assertEqual(member_client.delete(self.url(number=own)).status_code, 204)
        self.assertEqual(self.client.delete(self.url(number=number)).status_code, 204)  # owner/admin
        self.assertFalse(Issue.objects.filter(sandbox=self.env, number=number).exists())

    def test_assign_agent_links_conversation(self):
        number = self.create().json()["issue"]["number"]
        conv = Conversation.objects.create(user=self.user, workspace=self.workspace, title="work")
        self.env.conversations.add(conv)
        res = self.client.post(
            self.url(number=number, suffix="assign-agent/"),
            {"conversation_id": str(conv.pk), "branch": "issue-1-fix-login"},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        issue = res.json()["issue"]
        self.assertEqual(issue["branch"], "issue-1-fix-login")
        self.assertTrue(issue["assigned_to_agent"])
        self.assertEqual(issue["agent_conversation_id"], str(conv.pk))
        self.assertEqual(issue["status"], "in_progress")
        self.assertTrue(
            IssueComment.objects.filter(
                issue__number=number, author_type=IssueComment.AUTHOR_SYSTEM, conversation=conv
            ).exists()
        )
        cleared = self.client.post(self.url(number=number, suffix="unassign-agent/")).json()["issue"]
        self.assertFalse(cleared["assigned_to_agent"])
        self.assertIsNone(cleared["agent_conversation_id"])

    def test_assign_agent_rejects_foreign_or_unbound_conversations(self):
        number = self.create().json()["issue"]["number"]
        url = self.url(number=number, suffix="assign-agent/")
        unbound = Conversation.objects.create(user=self.user, workspace=self.workspace)
        other_env = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.env2.conversations.add(other_env)
        someone = User.objects.create_user(username="other", email="x@example.com", password="pw")
        theirs = Conversation.objects.create(user=someone, workspace=self.workspace)
        self.env.conversations.add(theirs)
        for conv_id in (str(unbound.pk), str(other_env.pk), str(theirs.pk), "not-a-uuid", None):
            res = self.client.post(url, {"conversation_id": conv_id}, format="json")
            self.assertEqual(res.status_code, 400, conv_id)
        self.assertFalse(Issue.objects.get(sandbox=self.env, number=number).assigned_to_agent)
