from types import SimpleNamespace
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from chat.models import Conversation, Message
from chat.views.predict import _setup_conversation
from sandbox.models import Sandbox
from sandbox.services.sandbox_service import SandboxBootstrapService


User = get_user_model()


@override_settings(
    CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        }
    }
)
class WorkspaceConversationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="workspace-history-user",
            password="test-pass-123",
        )
        self.workspace = SandboxBootstrapService.ensure_personal_filesystem(self.user)
        self.other_workspace = Sandbox.objects.create(
            user=self.user,
            slug="secondary",
            display_name="Secondary",
            filesystem_path="/workspace/secondary",
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_conversation_list_is_scoped_to_workspace(self):
        first = Conversation.objects.create(user=self.user, title="First workspace")
        second = Conversation.objects.create(user=self.user, title="Second workspace")
        self.workspace.conversations.add(first)
        self.other_workspace.conversations.add(second)

        response = self.client.get(
            "/conversations/",
            {"project_uuid": str(self.workspace.uuid)},
        )

        self.assertEqual(response.status_code, 200)
        ids = [item["uuid"] for item in response.data["conversations"]]
        self.assertEqual(ids, [str(first.uuid)])

    def test_new_conversation_is_linked_from_project_uuid(self):
        request = SimpleNamespace(
            user=self.user,
            data={"project_uuid": str(self.workspace.uuid)},
        )

        conversation, parent = _setup_conversation(request)

        self.assertIsNone(parent)
        self.assertTrue(self.workspace.conversations.filter(uuid=conversation.uuid).exists())

    def general_history(self, **params):
        return self.client.get('/conversations/', {
            'project_uuid': str(self.workspace.uuid),
            'general_only': 'true',
            **params,
        })

    def test_general_history_excludes_both_project_relationships(self):
        general = Conversation.objects.create(user=self.user, title='General')
        m2m = Conversation.objects.create(user=self.user, title='M2M project')
        legacy = Conversation.objects.create(user=self.user, title='Legacy project')
        self.workspace.conversations.add(general, m2m, legacy)
        self.other_workspace.conversations.add(m2m)
        self.other_workspace.conversation = legacy
        self.other_workspace.save(update_fields=['conversation'])

        response = self.general_history()

        self.assertEqual(response.status_code, 200)
        self.assertEqual([c['uuid'] for c in response.data['conversations']], [str(general.uuid)])
        self.assertTrue(self.other_workspace.conversations.filter(uuid=m2m.uuid).exists())
        self.other_workspace.refresh_from_db()
        self.assertEqual(self.other_workspace.conversation_id, legacy.pk)

    def test_shared_filesystem_is_not_a_project_even_for_legacy_link(self):
        general = Conversation.objects.create(user=self.user, title='Root legacy link')
        self.workspace.conversation = general
        self.workspace.save(update_fields=['conversation'])

        response = self.general_history()

        self.assertEqual([c['uuid'] for c in response.data['conversations']], [str(general.uuid)])

    def test_general_history_filters_before_pagination(self):
        general = [Conversation.objects.create(user=self.user, title=f'General {i}') for i in range(3)]
        assigned = [Conversation.objects.create(user=self.user, title=f'Project {i}') for i in range(5)]
        self.workspace.conversations.add(*general, *assigned)
        self.other_workspace.conversations.add(*assigned)

        first = self.general_history(limit=2)
        second = self.general_history(limit=2, offset=first.data['next_offset'])

        self.assertEqual(first.data['total'], 3)
        self.assertTrue(first.data['has_next'])
        self.assertEqual([c['uuid'] for c in first.data['conversations']], [str(c.uuid) for c in reversed(general[1:])])
        self.assertEqual([c['uuid'] for c in second.data['conversations']], [str(general[0].uuid)])
        self.assertFalse(second.data['has_next'])

    def test_general_history_stays_scoped_to_selected_workspace(self):
        other_user = User.objects.create_user(username='other-workspace-user', email='other-workspace@example.com')
        other_root = SandboxBootstrapService.ensure_personal_filesystem(other_user)
        selected = Conversation.objects.create(user=self.user, title='Selected workspace')
        outside = Conversation.objects.create(user=self.user, title='Other workspace')
        unlinked = Conversation.objects.create(user=self.user, title='Unlinked personal chat')
        self.workspace.conversations.add(selected)
        other_root.conversations.add(outside)

        response = self.general_history()

        self.assertEqual([c['uuid'] for c in response.data['conversations']], [str(selected.uuid)])
        self.assertNotIn(str(unlinked.uuid), [c['uuid'] for c in response.data['conversations']])
        forbidden = self.client.get('/conversations/', {'project_uuid': str(other_root.uuid), 'general_only': 'true'})
        self.assertEqual(forbidden.status_code, 404)

    def test_project_history_remains_available(self):
        linked = Conversation.objects.create(user=self.user, title='Project conversation')
        self.workspace.conversations.add(linked)
        self.other_workspace.conversations.add(linked)

        response = self.client.get('/conversations/', {'project_uuid': str(self.other_workspace.uuid)})

        self.assertEqual([c['uuid'] for c in response.data['conversations']], [str(linked.uuid)])

    def test_sent_message_order_survives_reload_and_reading_a_chat(self):
        older = Conversation.objects.create(user=self.user, title='Older')
        newer = Conversation.objects.create(user=self.user, title='Newer')
        self.workspace.conversations.add(older, newer)
        self.assertEqual([c['uuid'] for c in self.general_history().data['conversations']], [str(newer.uuid), str(older.uuid)])

        Message.objects.create(conversation=older, role='user', content='New message in the older chat')
        expected = [str(older.uuid), str(newer.uuid)]
        self.assertEqual([c['uuid'] for c in self.general_history().data['conversations']], expected)

        self.assertEqual(self.client.get(f'/conversations/{newer.uuid}/').status_code, 200)
        self.assertEqual([c['uuid'] for c in self.general_history().data['conversations']], expected)
        self.client.patch(f'/conversations/{newer.uuid}/rename/', {'title': 'Renamed'}, format='json')
        self.assertEqual([c['uuid'] for c in self.general_history().data['conversations']], expected)

    def test_late_assistant_reply_does_not_override_user_message_order(self):
        first = Conversation.objects.create(user=self.user, title='First')
        second = Conversation.objects.create(user=self.user, title='Second')
        self.workspace.conversations.add(first, second)
        self.other_workspace.conversations.add(first, second)
        Message.objects.create(conversation=first, role='user', content='First send')
        Message.objects.create(conversation=second, role='user', content='Second send')
        Message.objects.create(conversation=first, role='assistant', content='Delayed first reply')
        expected = [str(second.uuid), str(first.uuid)]

        general = self.client.get('/conversations/', {'project_uuid': str(self.workspace.uuid)})
        project = self.client.get('/conversations/', {'project_uuid': str(self.other_workspace.uuid)})
        self.assertEqual([c['uuid'] for c in general.data['conversations']], expected)
        self.assertEqual([c['uuid'] for c in project.data['conversations']], expected)

    def test_last_message_order_is_applied_before_pagination(self):
        conversations = [Conversation.objects.create(user=self.user, title=f'Chat {i}') for i in range(3)]
        self.workspace.conversations.add(*conversations)
        base = timezone.now()
        for i, conversation in enumerate(reversed(conversations)):
            message = Message.objects.create(conversation=conversation, role='user', content='Sent')
            Message.objects.filter(pk=message.pk).update(created_at=base + timedelta(seconds=i))

        first = self.general_history(limit=2)
        second = self.general_history(limit=2, offset=first.data['next_offset'])

        self.assertEqual([c['uuid'] for c in first.data['conversations']], [str(c.uuid) for c in conversations[:2]])
        self.assertEqual([c['uuid'] for c in second.data['conversations']], [str(conversations[2].uuid)])
