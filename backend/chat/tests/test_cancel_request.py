import uuid
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from chat.models import Conversation, Request
from model.models import Model
from utils.cache import is_request_cancelled

User = get_user_model()


@override_settings(
    CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        }
    }
)
class CancelRequestTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="test-cancel-user",
            email="cancel1@example.com",
            password="test-pass-123",
        )
        self.other_user = User.objects.create_user(
            username="other-cancel-user",
            email="cancel2@example.com",
            password="test-pass-123",
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

        self.conversation = Conversation.objects.create(
            user=self.user,
            title="Cancel test chat"
        )
        self.model = Model.objects.create(
            name="test-model",
            model_type="text",
            author=self.user,
        )

    def test_cancel_active_request_success(self):
        req = Request.objects.create(
            user=self.user,
            conversation=self.conversation,
            model=self.model,
            status="processing",
        )
        url = f"/requests/{req.uuid}/cancel/"
        response = self.client.post(url, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        req.refresh_from_db()
        self.assertEqual(req.status, "canceled")
        self.assertTrue(is_request_cancelled(str(req.uuid)))

    def test_cancel_already_canceled_is_idempotent(self):
        req = Request.objects.create(
            user=self.user,
            conversation=self.conversation,
            model=self.model,
            status="canceled",
        )
        url = f"/requests/{req.uuid}/cancel/"
        response = self.client.post(url, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("already", response.data.get("message", "").lower())

    def test_cancel_conversation_active_request(self):
        req1 = Request.objects.create(
            user=self.user,
            conversation=self.conversation,
            model=self.model,
            status="processing",
        )
        req2 = Request.objects.create(
            user=self.user,
            conversation=self.conversation,
            model=self.model,
            status="pending",
        )
        url = f"/conversations/{self.conversation.uuid}/cancel/"
        response = self.client.post(url, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        req1.refresh_from_db()
        req2.refresh_from_db()
        self.assertEqual(req1.status, "canceled")
        self.assertEqual(req2.status, "canceled")
        self.assertTrue(is_request_cancelled(str(req1.uuid)))
        self.assertTrue(is_request_cancelled(str(req2.uuid)))

    def test_other_user_cannot_cancel_request(self):
        req = Request.objects.create(
            user=self.other_user,
            conversation=Conversation.objects.create(user=self.other_user, title="Other chat"),
            model=self.model,
            status="processing",
        )
        url = f"/requests/{req.uuid}/cancel/"
        response = self.client.post(url, format="json")

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_cancel_request_persists_partial_content_and_get_chat_returns_it(self):
        from chat.models import Message
        user_msg = Message.objects.create(
            conversation=self.conversation,
            role="user",
            content="Tell me a story",
        )
        req = Request.objects.create(
            user=self.user,
            conversation=self.conversation,
            parent=user_msg,
            model=self.model,
            status="processing",
        )
        url = f"/requests/{req.uuid}/cancel/"
        payload = {
            "content": "Once upon a time in a faraway forest...",
            "thinking": "Thinking about the opening line...",
        }
        response = self.client.post(url, data=payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Verify a Message was created for the partial response
        assistant_msg = Message.objects.filter(conversation=self.conversation, role="assistant", parent=user_msg).first()
        self.assertIsNotNone(assistant_msg)
        self.assertEqual(assistant_msg.content, "Once upon a time in a faraway forest...")
        self.assertEqual(assistant_msg.thinking, "Thinking about the opening line...")

        # Verify get_chat returns this partial assistant message
        chat_resp = self.client.get(f"/conversations/{self.conversation.uuid}/")
        self.assertEqual(chat_resp.status_code, status.HTTP_200_OK)
        messages = chat_resp.data["conversation"]["messages"]
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["role"], "user")
        self.assertEqual(messages[1]["role"], "assistant")
        self.assertEqual(messages[1]["content"], "Once upon a time in a faraway forest...")
        self.assertIsNone(messages[1]["error"])

    def test_cancel_does_not_create_duplicate_assistant_messages(self):
        from chat.models import Message
        from chat.services.chat_service import ChatService

        user_msg = Message.objects.create(
            conversation=self.conversation,
            role="user",
            content="Run multiple tools",
        )
        req = Request.objects.create(
            user=self.user,
            conversation=self.conversation,
            parent=user_msg,
            model=self.model,
            status="processing",
        )

        # 1. Client cancel endpoint called with 12 tools
        client_tools = [{"id": f"tool_{i}", "name": "shell_exec", "status": "done"} for i in range(12)]
        client_tools.append({"id": "tool_12", "name": "shell_exec", "status": "error"})
        response = self.client.post(f"/requests/{req.uuid}/cancel/", data={"tool_calls": client_tools}, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # 2. Worker thread also completes and saves 14 tools
        worker_tools = [{"id": f"tool_{i}", "name": "shell_exec", "status": "done"} for i in range(12)]
        worker_tools.append({"id": "tool_12", "name": "shell_exec", "status": "error"})
        worker_tools.append({"id": "tool_13", "name": "shell_exec", "status": "error"})

        service = ChatService(self.model, self.conversation, req, {})
        service._save_partial_response_on_cancel(tool_calls=worker_tools)

        # 3. Assert exactly ONE assistant message exists in database
        assistant_msgs = Message.objects.filter(conversation=self.conversation, role="assistant", parent=user_msg)
        self.assertEqual(assistant_msgs.count(), 1)
        final_msg = assistant_msgs.first()
        # Should have updated to the worker's 14 tools
        self.assertEqual(len(final_msg.tool_calls), 14)

        # 4. Assert get_chat returns exactly 2 messages (1 user, 1 assistant)
        chat_resp = self.client.get(f"/conversations/{self.conversation.uuid}/")
        self.assertEqual(chat_resp.status_code, status.HTTP_200_OK)
        returned_msgs = chat_resp.data["conversation"]["messages"]
        self.assertEqual(len(returned_msgs), 2)
        self.assertEqual(returned_msgs[0]["role"], "user")
        self.assertEqual(returned_msgs[1]["role"], "assistant")
        self.assertEqual(len(returned_msgs[1]["tool_calls"]), 14)
