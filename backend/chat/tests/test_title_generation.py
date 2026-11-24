import json
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings

from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation, Message, Tool
from chat.services.chat_service import ChatService
from chat.services.title_generation import save_generated_title, title_generation_available
from chat.services.utils import generate_title, sse_event
from chat.views.openai_completions import _openai_stateful_stream_wrapper


AUX_TARGET = {"api_key": "sk-workspace", "base_url": "https://openrouter.ai/api/v1", "model": "vendor/small"}


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class TitleGenerationTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="title-user", email="title@example.com")
        self.conversation = Conversation.objects.create(user=self.user)
        self.message = Message.objects.create(conversation=self.conversation, role="user", content="Python ile merhaba dünya yaz")

    def service(self):
        service = ChatService.__new__(ChatService)
        service.conversation = self.conversation
        service.current_request = SimpleNamespace(parent=self.message, uuid="request", uses_byok=False)
        service._settle_round = Mock()
        # Side calls run on the workspace's own key; see auxiliary_target.
        service._auxiliary_llm_target = Mock(return_value=dict(AUX_TARGET))
        service.tools = None
        service._get_mcp_tools = lambda: []
        return service

    def save_title(self, raw):
        return save_generated_title(self.conversation, raw, original_title=self.conversation.title)

    def test_title_is_never_exposed_as_tool_or_in_system_guide(self):
        schema = {"type": "function", "function": {"name": "title_generation"}}
        Tool.objects.create(name="title_generation", description="Title", parameters_schema={}, enabled=True, is_builtin=True)
        service = self.service()
        service.tools = [schema]
        service.tools = service._merge_mcp_tools()
        self.assertNotIn("title_generation", [tool["function"]["name"] for tool in service.tools])
        service.system_prompt = None
        service.attachments_context = ""
        service._model_catalog_guide = lambda: ""
        service._trim_messages_to_context = lambda messages: messages
        self.assertNotIn("title_generation", service._build_messages()[0]["content"])

    def test_retired_tool_cannot_rename_or_bootstrap_workspace(self):
        with patch("sandbox.services.sandbox_service.SandboxBootstrapService.conversation_project") as project:
            result = json.loads(execute_builtin_tool(self.user, "title_generation", {"title": "Wrong"}, conversation=self.conversation))
        self.assertIn("error", result)
        project.assert_not_called()
        self.conversation.refresh_from_db()
        self.assertIsNone(self.conversation.title)

    def test_saves_normalized_title_and_repeated_worker_cannot_replace_it(self):
        self.assertEqual(self.save_title('  "Python ile\nMerhaba Dünya"  '), "Python ile Merhaba Dünya")
        self.assertIsNone(self.save_title("Second title"))
        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.title, "Python ile Merhaba Dünya")

    def test_manual_rename_wins_even_if_shared_instance_is_refreshed(self):
        started = Event()
        release = Event()

        def generate(*args, **kwargs):
            started.set()
            release.wait(3)
            return "Generated title"

        with patch("chat.services.chat_service.generate_title", side_effect=generate):
            thread = self.service()._start_title_generation()
            try:
                self.assertTrue(started.wait(3))
                Conversation.objects.filter(pk=self.conversation.pk).update(title="User chosen title")
                self.conversation.refresh_from_db()
            finally:
                release.set()
                thread.join(3)
        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.title, "User chosen title")

    def test_invalid_titles_do_not_save(self):
        for title in [None, [], "", " \n ", "x" * 81, "Untitled Conversation"]:
            with self.subTest(title=title):
                self.assertIsNone(self.save_title(title))

    def test_late_title_can_save_after_assistant_message_is_persisted(self):
        Message.objects.create(conversation=self.conversation, role="assistant", content="Finished")
        self.assertEqual(self.save_title("Late title"), "Late title")

    def test_only_new_conversations_start_a_title_job(self):
        for title in [None, "", "New Conversation", "Conversation"]:
            self.conversation.title = title
            self.assertTrue(title_generation_available(self.conversation))
        self.conversation.title = "Manual title"
        with patch("chat.services.chat_service.generate_title") as generate:
            self.assertIsNone(self.service()._start_title_generation())
            generate.assert_not_called()
        self.conversation.title = None
        Message.objects.create(conversation=self.conversation, role="user", content="Follow up")
        self.assertFalse(title_generation_available(self.conversation))
        Message.objects.filter(conversation=self.conversation).exclude(pk=self.message.pk).delete()
        Message.objects.create(conversation=self.conversation, role="assistant", content="Hello")
        self.assertFalse(title_generation_available(self.conversation))

    def test_ensure_title_never_calls_model(self):
        with patch("chat.services.chat_service.generate_title") as generate:
            self.assertEqual(self.service()._ensure_title(), "Untitled Conversation")
            generate.assert_not_called()

    def test_title_chunk_is_metadata_without_tool_call_or_finish(self):
        chunks = list(_openai_stateful_stream_wrapper([
            sse_event("title", {"title": "Python Merhaba Dünya"}),
            sse_event("message", {"v": "Hello"}),
            sse_event("complete", {"title": "Python Merhaba Dünya"}),
        ], "model", "completion", 1, self.conversation.uuid, "request"))
        data = json.loads(chunks[0].removeprefix("data: "))
        self.assertEqual(data["neuronrunner_metadata"]["title"], "Python Merhaba Dünya")
        self.assertEqual(data["choices"][0]["delta"], {})
        self.assertIsNone(data["choices"][0]["finish_reason"])
        self.assertIn('"content": "Hello"', chunks[1])
        self.assertEqual(chunks[-1], "data: [DONE]\n\n")

    def test_title_is_emitted_while_response_generation_is_blocked(self):
        service = self.service()
        model_started = Event()
        release_model = Event()

        def generate(*args, **kwargs):
            if not model_started.wait(3):
                raise RuntimeError("Main generation never started")
            return "Parallel title"

        def model_events():
            model_started.set()
            release_model.wait(3)
            yield sse_event("complete", {"response": "Hello"})

        service._generate_stream_events = model_events
        with patch("chat.services.chat_service.generate_title", side_effect=generate):
            stream = service.generate_streaming()
            try:
                event = next(stream)
                self.assertTrue(event.startswith("event: title\n"))
                self.assertFalse(release_model.is_set())
            finally:
                release_model.set()
                remaining = list(stream)
        self.assertEqual(len(remaining), 1)
        self.assertTrue(remaining[0].startswith("event: complete\n"))

    def test_response_chunks_flow_before_late_title_and_terminal_waits_for_title(self):
        service = self.service()
        title_started = Event()
        release_title = Event()

        def generate(*args, **kwargs):
            title_started.set()
            release_title.wait(3)
            return "Late title"

        def model_events():
            self.assertTrue(title_started.wait(3))
            yield sse_event("message", {"v": "Hello"})
            yield sse_event("complete", {"title": "Untitled Conversation"})

        service._generate_stream_events = model_events
        with patch("chat.services.chat_service.generate_title", side_effect=generate):
            stream = service.generate_streaming()
            try:
                self.assertTrue(next(stream).startswith("event: message\n"))
                self.assertFalse(release_title.is_set())
            finally:
                release_title.set()
                remaining = list(stream)
        self.assertEqual(len(remaining), 2)
        self.assertTrue(remaining[0].startswith("event: title\n"))
        complete = json.loads(remaining[1].split("data: ", 1)[1])
        self.assertEqual(complete["title"], "Late title")

    def test_title_failure_does_not_fail_response_stream(self):
        service = self.service()
        service._generate_stream_events = lambda: iter([sse_event("message", {"v": "Hello"}), sse_event("complete", {})])
        with patch("chat.services.chat_service.generate_title", side_effect=RuntimeError("Unavailable")), self.assertLogs("chat.services.chat_service", level="ERROR"):
            events = list(service.generate_streaming())
        self.assertEqual(len(events), 2)
        self.assertTrue(events[-1].startswith("event: complete\n"))

    def test_client_disconnect_does_not_stop_title_or_response_workers(self):
        service = self.service()
        release = Event()
        completed = Event()
        ensure_title = service._ensure_title

        def generate(*args, **kwargs):
            release.wait(3)
            return "Disconnected title"

        def model_events():
            yield sse_event("message", {"v": "Hello"})
            release.wait(3)
            yield sse_event("complete", {})

        def final_title():
            title = ensure_title()
            completed.set()
            return title

        service._generate_stream_events = model_events
        service._ensure_title = final_title
        with patch("chat.services.chat_service.generate_title", side_effect=generate):
            stream = service.generate_streaming()
            try:
                self.assertTrue(next(stream).startswith("event: message\n"))
                stream.close()
            finally:
                release.set()
            self.assertTrue(completed.wait(3))
        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.title, "Disconnected title")

    def test_sync_generation_also_runs_title_in_parallel(self):
        service = self.service()
        title_started = Event()
        main_started = Event()
        service.model_tag = SimpleNamespace(is_external=True)
        service._persist_token_snapshot = Mock()
        service._start_memory_thread = Mock()
        service._raise_if_canceled = Mock()
        service._apply_tool_progress_guidance = Mock()
        service._save_response = lambda *args, **kwargs: {"title": service._ensure_title()}

        def generate(*args, **kwargs):
            title_started.set()
            if not main_started.wait(3):
                raise RuntimeError("Sync main generation never started")
            return "Sync parallel title"

        def model_response():
            self.assertTrue(title_started.wait(3))
            main_started.set()
            return "Hello", None, 1, 2, []

        service._generate_external_sync = model_response
        with patch("chat.services.chat_service.generate_title", side_effect=generate):
            self.assertEqual(service.generate_sync()["title"], "Sync parallel title")

    def test_title_request_has_bounded_timeout_and_no_retries(self):
        with patch("chat.services.utils.OpenAI") as client:
            client.return_value.chat.completions.create.return_value.choices = [SimpleNamespace(message=SimpleNamespace(content="Başlık"))]
            self.assertEqual(generate_title("Merhaba", **AUX_TARGET), "Başlık")
        self.assertEqual(client.call_args.kwargs["timeout"], 15.0)
        self.assertEqual(client.call_args.kwargs["max_retries"], 0)
        self.assertEqual(client.call_args.kwargs["api_key"], "sk-workspace")
        self.assertEqual(client.return_value.chat.completions.create.call_args.kwargs["model"], "vendor/small")

    def test_without_workspace_key_title_is_the_message_and_no_model_is_called(self):
        # e.g. a BYOS-only workspace: the subscription lives in the sandbox CLI.
        service = self.service()
        service._auxiliary_llm_target = Mock(return_value=None)
        with patch("chat.services.chat_service.generate_title") as gen_title:
            thread = service._start_title_generation()
            self.assertIsNotNone(thread)
            thread.join(3)
        gen_title.assert_not_called()
        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.title, "Python ile merhaba dünya yaz")

    def test_title_uses_the_auxiliary_target_credentials(self):
        service = self.service()
        with patch("chat.services.chat_service.generate_title", return_value="Workspace API Başlığı") as gen_title:
            thread = service._start_title_generation()
            self.assertIsNotNone(thread)
            thread.join(3)
        gen_title.assert_called_once_with(self.message.content, is_image=False, **AUX_TARGET)
        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.title, "Workspace API Başlığı")
