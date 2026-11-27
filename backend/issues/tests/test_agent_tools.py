"""Agent-facing issue tools: scope, permissions and registration."""
import json

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

import chat.tools  # noqa: F401 — registers the handlers
from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation
from chat.services.byos_mcp_bridge import list_byos_mcp_tools
from chat.services.chat_service import ChatService
from chat.tools import execute
from issues.models import Issue, IssueComment
from issues.services import issue_service as svc
from sandbox.models import Sandbox, Workspace, WorkspaceMembership

User = get_user_model()


def _tool_names(tools):
    return {tool["function"]["name"] for tool in tools}


@override_settings(SANDBOX_PROVIDER="docker")
class AgentIssueToolTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="dev", email="d@example.com", password="pw")
        self.workspace = Workspace.objects.create(name="WS", slug="ws", owner=self.user)
        WorkspaceMembership.objects.create(
            workspace=self.workspace, user=self.user, role=WorkspaceMembership.ROLE_OWNER
        )
        self.env = Sandbox.objects.create(
            user=self.user, workspace=self.workspace, slug="app", display_name="app", filesystem_path="/workspace/app"
        )
        self.other_env = Sandbox.objects.create(
            user=self.user, workspace=self.workspace, slug="other", display_name="other", filesystem_path="/workspace/other"
        )
        self.conv = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.env.conversations.add(self.conv)
        self.issue = svc.create_issue(sandbox=self.env, title="Crash on save", user=self.user)

    def call(self, name, user=None, conversation=None, **arguments):
        conversation = conversation or self.conv
        return execute(name, user or self.user, {"_conversation_id": str(conversation.pk), **arguments})

    def link(self, issue=None):
        svc.assign_agent(issue or self.issue, self.conv, user=self.user)

    def test_create_is_agent_authored_and_unassigned(self):
        result = self.call("issue_create", title="Flaky test", body="seen twice", labels=["flaky"], priority="low")
        self.assertTrue(result["created"], result)
        issue = Issue.objects.get(sandbox=self.env, number=result["number"])
        self.assertEqual(issue.creator_type, Issue.CREATOR_AGENT)
        self.assertEqual(issue.source_conversation, self.conv)
        self.assertIsNone(issue.creator_user)
        self.assertFalse(issue.assigned_to_agent)
        self.assertIsNone(issue.assignee_user)
        self.assertEqual(issue.labels, [{"name": "flaky", "color": ""}])

    def test_create_validates_title(self):
        self.assertIn("error", self.call("issue_create", title="  "))

    def test_list_and_get_are_scoped_to_the_conversation_environment(self):
        svc.create_issue(sandbox=self.other_env, title="Elsewhere", user=self.user)
        listed = self.call("issue_list", state="all")
        self.assertEqual([i["title"] for i in listed["issues"]], ["Crash on save"])
        got = self.call("issue_get", number=self.issue.number)
        self.assertEqual(got["issue"]["title"], "Crash on save")
        self.assertIn("error", self.call("issue_get", number=999))
        self.assertIn("error", self.call("issue_get", number="abc"))

    def test_comment_defaults_to_the_linked_issue_and_is_attributed_to_the_agent(self):
        self.assertIn("error", self.call("issue_comment", body="progress"))  # nothing linked yet
        self.link()
        result = self.call("issue_comment", body="Found the root cause")
        self.assertTrue(result["commented"], result)
        comment = IssueComment.objects.filter(issue=self.issue, author_type=IssueComment.AUTHOR_AGENT).get()
        self.assertEqual((comment.author_name, comment.conversation), ("Agent", self.conv))
        other = svc.create_issue(sandbox=self.env, title="Other", user=self.user)
        self.assertTrue(self.call("issue_comment", number=other.number, body="fyi")["commented"])

    def test_update_only_touches_the_assigned_issue(self):
        other = svc.create_issue(sandbox=self.env, title="Other", user=self.user)
        self.assertIn("error", self.call("issue_update", status="in_review"))  # nothing assigned yet
        self.link()
        self.assertIn("error", self.call("issue_update", number=other.number, status="in_review"))
        ok = self.call(
            "issue_update", status="in_review", branch="issue-1-fix", pr_url="https://github.com/a/b/pull/9", pr_number=9
        )
        self.assertTrue(ok["updated"], ok)
        self.issue.refresh_from_db()
        self.assertEqual(
            (self.issue.status, self.issue.branch, self.issue.pr_url, self.issue.pr_number),
            ("in_review", "issue-1-fix", "https://github.com/a/b/pull/9", 9),
        )
        other.refresh_from_db()
        self.assertEqual(other.status, Issue.STATUS_TODO)

    def test_agents_cannot_close_issues_or_edit_text(self):
        self.link()
        self.assertIn("error", self.call("issue_update", status="done"))
        self.assertIn("error", self.call("issue_update", status="cancelled"))
        self.assertIn("error", self.call("issue_update", pr_number="x"))
        self.assertIn("error", self.call("issue_update"))
        self.call("issue_update", status="in_progress", title="Hacked", body="Hacked")
        self.issue.refresh_from_db()
        self.assertEqual(self.issue.title, "Crash on save")
        self.assertEqual(self.issue.body, "")

    def test_conversation_scope_cannot_be_spoofed_through_arguments(self):
        other_conv = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.other_env.conversations.add(other_conv)
        raw = execute_builtin_tool(
            self.user,
            "issue_create",
            {"_conversation_id": str(other_conv.pk), "_sandbox_uuid": str(self.other_env.uuid), "title": "Spoof"},
            conversation=self.conv,
        )
        created = json.loads(raw)
        self.assertTrue(created["created"], created)
        self.assertTrue(Issue.objects.filter(sandbox=self.env, title="Spoof").exists())
        self.assertFalse(Issue.objects.filter(sandbox=self.other_env).exists())

    def test_requires_a_bound_conversation_and_a_member(self):
        self.assertIn("error", execute("issue_list", self.user, {}))
        unbound = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.assertIn("error", self.call("issue_list", conversation=unbound))
        stranger = User.objects.create_user(username="eve", email="e@example.com", password="pw")
        denied = self.call("issue_list", user=stranger)
        self.assertIn("error", denied)
        self.assertNotIn("issues", denied)

    def test_tools_are_offered_only_to_environment_bound_chats(self):
        def merged(conversation):
            service = ChatService.__new__(ChatService)
            service.tools = []
            service.conversation = conversation
            service._get_mcp_tools = lambda: []
            return _tool_names(service._merge_mcp_tools() or [])

        expected = {"issue_list", "issue_get", "issue_create", "issue_comment", "issue_update"}
        self.assertTrue(expected <= merged(self.conv))
        unbound = Conversation.objects.create(user=self.user, workspace=self.workspace)
        self.assertFalse(expected & merged(unbound))

    def test_byos_bridge_exposes_the_issue_tools(self):
        names = {tool["name"] for tool in list_byos_mcp_tools(self.user, self.conv)}
        self.assertTrue({"issue_create", "issue_comment", "issue_update"} <= names)
