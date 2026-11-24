from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from chat.models import Conversation, Message, Request

User = get_user_model()


@override_settings(
    CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        }
    }
)
class MessageUndoTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="test-undo-user",
            email="undo1@example.com",
            password="test-pass-123",
        )
        self.other_user = User.objects.create_user(
            username="other-user",
            email="undo2@example.com",
            password="test-pass-123",
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

        self.conversation = Conversation.objects.create(
            user=self.user,
            title="Undo test chat"
        )

    def test_undo_latest_turn_success(self):
        u1 = Message.objects.create(
            conversation=self.conversation,
            role="user",
            content="Hello world"
        )
        a1 = Message.objects.create(
            conversation=self.conversation,
            parent=u1,
            role="assistant",
            content="Hi there!"
        )
        r1 = Request.objects.create(
            conversation=self.conversation,
            parent=u1,
            user=self.user,
            status="completed"
        )

        response = self.client.post(
            f"/conversations/{self.conversation.uuid}/messages/{u1.uuid}/undo/",
            data={},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["ok"])
        self.assertEqual(response.data["undone_content"], "Hello world")
        self.assertIn(str(u1.uuid), response.data["deleted_uuids"])
        self.assertIn(str(a1.uuid), response.data["deleted_uuids"])

        # Check DB
        self.assertFalse(Message.objects.filter(pk=u1.pk).exists())
        self.assertFalse(Message.objects.filter(pk=a1.pk).exists())
        self.assertFalse(Request.objects.filter(pk=r1.pk).exists())

    def test_undo_earlier_turn_deletes_subsequent_turns(self):
        u1 = Message.objects.create(conversation=self.conversation, role="user", content="Turn 1 user")
        a1 = Message.objects.create(conversation=self.conversation, parent=u1, role="assistant", content="Turn 1 reply")
        u2 = Message.objects.create(conversation=self.conversation, parent=a1, role="user", content="Turn 2 user")
        a2 = Message.objects.create(conversation=self.conversation, parent=u2, role="assistant", content="Turn 2 reply")

        # Undo turn 1: should delete u1, a1, u2, a2
        response = self.client.post(
            f"/conversations/{self.conversation.uuid}/messages/{u1.uuid}/undo/",
            data={},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(Message.objects.filter(conversation=self.conversation).count(), 0)

    def test_undo_assistant_message_rejected(self):
        u1 = Message.objects.create(conversation=self.conversation, role="user", content="User prompt")
        a1 = Message.objects.create(conversation=self.conversation, parent=u1, role="assistant", content="Assistant reply")

        response = self.client.post(
            f"/conversations/{self.conversation.uuid}/messages/{a1.uuid}/undo/",
            data={},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Only user messages can be undone", response.data["error"])

    def test_undo_unauthorized_user_forbidden(self):
        u1 = Message.objects.create(conversation=self.conversation, role="user", content="Secret user prompt")
        
        other_client = APIClient()
        other_client.force_authenticate(user=self.other_user)

        response = other_client.post(
            f"/conversations/{self.conversation.uuid}/messages/{u1.uuid}/undo/",
            data={},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_undo_direct_url_route(self):
        u1 = Message.objects.create(
            conversation=self.conversation,
            role="user",
            content="Direct URL prompt"
        )
        response = self.client.post(
            f"/messages/{u1.uuid}/undo/",
            data={},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(Message.objects.filter(pk=u1.pk).exists())
