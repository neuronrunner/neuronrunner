from datetime import timedelta
from unittest.mock import Mock

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from chat.models import Conversation, Message, Request
from chat.services.chat_service import ChatService
from chat.views.predict import _resolve_parent_message
from utils.cache import clear_request_stream_state, set_request_stream_state


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class FailedRequestHistoryTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="failed-history-user")
        self.conversation = Conversation.objects.create(user=self.user, title="History")
        self.first = Message.objects.create(conversation=self.conversation, role="user", content="Earlier question")
        self.answer = Message.objects.create(conversation=self.conversation, role="assistant", parent=self.first, content="Earlier answer")
        self.prompt = Message.objects.create(conversation=self.conversation, role="user", parent=self.answer, content="Run the command")
        self.request = Request.objects.create(conversation=self.conversation, parent=self.prompt, user=self.user, status="processing", started_at=timezone.now())
        self.tool = {"id": "shell-1", "function": {"name": "shell_exec", "arguments": '{"command":"echo hello"}'}, "output": "hello\n", "title": "Shell Exec"}
        self.phases = [{"type": "tool_call", "toolName": "shell_exec", "toolCallId": "shell-1", "label": "Shell Exec", "title": "Shell Exec"}]
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)
        self.addCleanup(clear_request_stream_state, str(self.request.pk))

    def history(self):
        response = self.client.get(f"/conversations/{self.conversation.pk}/")
        self.assertEqual(response.status_code, 200)
        return response.data["conversation"]

    def mark_failed(self, **values):
        Request.objects.filter(pk=self.request.pk).update(status="failed", error_message="Request timed out after 10 minutes processing without completion", **values)

    def listed_conversation(self):
        response = self.client.get('/conversations/')
        self.assertEqual(response.status_code, 200)
        return next(item for item in response.data['conversations'] if item['uuid'] == str(self.conversation.pk))

    def test_list_clears_abandoned_activity_without_opening_conversation(self):
        Request.objects.filter(pk=self.request.pk).update(started_at=timezone.now() - timedelta(minutes=11))
        self.assertFalse(self.listed_conversation()['is_generating'])
        self.request.refresh_from_db()
        self.assertEqual(self.request.status, 'failed')
        self.assertIn('worker heartbeat', self.request.error_message)

    def test_failed_request_is_not_generating_in_history_list(self):
        self.mark_failed()
        self.assertFalse(self.listed_conversation()['is_generating'])

    def test_list_keeps_long_running_worker_with_recent_heartbeat_active(self):
        Request.objects.filter(pk=self.request.pk).update(
            started_at=timezone.now() - timedelta(hours=2), last_activity_at=timezone.now(),
        )
        self.assertTrue(self.listed_conversation()['is_generating'])
        self.request.refresh_from_db()
        self.assertEqual(self.request.status, 'processing')

    def test_list_clears_expired_pending_activity(self):
        Request.objects.filter(pk=self.request.pk).update(
            status='pending', created_at=timezone.now() - timedelta(minutes=6),
        )
        self.assertFalse(self.listed_conversation()['is_generating'])
        self.request.refresh_from_db()
        self.assertEqual(self.request.status, 'failed')

    def test_failed_request_preserves_previous_messages_and_partial_tool_output(self):
        self.mark_failed(partial_content="Working", partial_thinking="Checking", partial_phases=self.phases, partial_tool_calls=[self.tool])
        for _ in range(2):
            history = self.history()
            self.assertEqual([msg["content"] for msg in history["messages"][:3]], ["Earlier question", "Earlier answer", "Run the command"])
            failed = history["messages"][-1]
            self.assertEqual(failed['request_uuid'], str(self.request.pk))
            self.assertEqual(failed["content"], "Working")
            self.assertEqual(failed["thinking"], "Checking")
            self.assertEqual(failed["phases"], self.phases)
            self.assertEqual(failed["tool_calls"][0]["output"], "hello\n")
            self.assertIn("timed out", failed["error"])
            self.assertIsNone(history["active_request"])

    def test_legacy_failed_request_recovers_available_cached_activity(self):
        self.mark_failed()
        set_request_stream_state(str(self.request.pk), {"content": "Legacy partial", "phases": self.phases, "tool_calls": [self.tool]})
        failed = self.history()["messages"][-1]
        self.assertEqual(failed["content"], "Legacy partial")
        self.assertEqual(failed["tool_calls"], [self.tool])

    def test_timeout_and_partial_history_appear_in_same_poll(self):
        Request.objects.filter(pk=self.request.pk).update(started_at=timezone.now() - timedelta(minutes=11), partial_tool_calls=[self.tool], partial_phases=self.phases)
        history = self.history()
        self.assertIsNone(history["active_request"])
        self.assertEqual(len(history["messages"]), 4)
        self.assertEqual(history["messages"][-1]["tool_calls"], [self.tool])
        self.assertIn("worker heartbeat", history["messages"][-1]["error"])

    def test_partial_snapshots_survive_cache_loss(self):
        service = ChatService.__new__(ChatService)
        service.current_request = self.request
        service._last_partial_save = 0
        service._update_partial_state(content="Working", thinking="Checking", phases=self.phases, tool_calls=[self.tool], force=True)
        clear_request_stream_state(str(self.request.pk))
        self.mark_failed()
        failed = self.history()["messages"][-1]
        self.assertEqual(failed["content"], "Working")
        self.assertEqual(failed["tool_calls"], [self.tool])
        self.assertEqual(failed["phases"][0]["toolCallId"], "shell-1")

    def test_worker_failure_moves_persisted_activity_into_assistant_message(self):
        Request.objects.filter(pk=self.request.pk).update(partial_tool_calls=[self.tool], partial_phases=self.phases)
        service = ChatService.__new__(ChatService)
        service.current_request = self.request
        service.conversation = self.conversation
        service._ensure_title = Mock()
        service._save_partial_response_on_failure("Provider disconnected")
        self.request.refresh_from_db()
        self.assertIsNone(self.request.partial_tool_calls)
        history = self.history()
        self.assertEqual(len(history["messages"]), 4)
        self.assertEqual(history["messages"][-1]["tool_calls"], [self.tool])
        self.assertEqual(history["messages"][-1]["error"], "Provider disconnected")
        self.assertEqual(history['messages'][-1]['request_uuid'], str(self.request.pk))

    def test_existing_saved_assistant_history_is_not_duplicated(self):
        Message.objects.create(conversation=self.conversation, parent=self.prompt, role="assistant", content="Saved partial", tool_calls=[self.tool], phases=self.phases)
        self.mark_failed()
        history = self.history()
        self.assertEqual(len(history["messages"]), 4)
        self.assertEqual(history["messages"][-1]["content"], "Saved partial")
        self.assertEqual(history["messages"][-1]["tool_calls"], [self.tool])

    def test_continue_parent_request_uuid_resolves_to_saved_partial_reply(self):
        partial = Message.objects.create(
            conversation=self.conversation, parent=self.prompt, role="assistant",
            content="Running the grep", tool_calls=[self.tool],
        )
        self.mark_failed(partial_tool_calls=[self.tool])
        resolved = _resolve_parent_message(self.conversation, str(self.request.pk))
        self.assertEqual(resolved.pk, partial.pk)

    def test_continue_parent_request_uuid_without_saved_reply_resolves_to_prompt(self):
        self.mark_failed()
        resolved = _resolve_parent_message(self.conversation, str(self.request.pk))
        self.assertEqual(resolved.pk, self.prompt.pk)

    def test_continue_parent_virtual_failed_prefix_resolves_to_prompt(self):
        self.mark_failed()
        resolved = _resolve_parent_message(self.conversation, f"virtual-failed-{self.request.pk}")
        self.assertEqual(resolved.pk, self.prompt.pk)

    def test_continue_parent_client_placeholder_resolves_to_latest_message(self):
        self.mark_failed()
        resolved = _resolve_parent_message(self.conversation, "error-1700000000000")
        self.assertEqual(resolved.pk, self.prompt.pk)

    def test_continue_parent_request_uuid_ignores_reply_from_later_retry(self):
        self.mark_failed()
        Request.objects.create(conversation=self.conversation, parent=self.prompt, user=self.user, status="completed")
        Message.objects.create(
            conversation=self.conversation, parent=self.prompt, role="assistant",
            content="Retry succeeded",
        )
        resolved = _resolve_parent_message(self.conversation, str(self.request.pk))
        self.assertEqual(resolved.pk, self.prompt.pk)

    def test_retry_answer_does_not_replace_failed_attempt_history(self):
        self.mark_failed(partial_tool_calls=[self.tool])
        Request.objects.create(conversation=self.conversation, parent=self.prompt, user=self.user, status="completed")
        Message.objects.create(conversation=self.conversation, parent=self.prompt, role="assistant", content="Retry succeeded")
        history = self.history()
        self.assertEqual(len(history["messages"]), 5)
        failed = next(msg for msg in history["messages"] if msg["uuid"].startswith("virtual-failed-"))
        self.assertEqual(failed["tool_calls"], [self.tool])
        retry = next(msg for msg in history["messages"] if msg["content"] == "Retry succeeded")
        self.assertIsNone(retry["error"])
