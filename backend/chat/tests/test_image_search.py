from importlib import import_module
import json
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.apps import apps
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation, Message, Tool
from chat.services.chat_service import ChatService
from chat.services.tool_execution import is_parallel_web_read
from chat.services.utils import build_parent_chain
from chat.tools.image_search import IMAGE_SEARCH_TOOL, handle
from chat.tools.view_image import image_context_from_tools


@patch("chat.tools.web_search._get_api_key", return_value="test-key")
class ImageSearchTests(SimpleTestCase):
    def setUp(self):
        patcher = patch("chat.tools.image_search.fetch_image", side_effect=lambda url: {"status": "ok", "image_url": url, "context_url": "data:image/jpeg;base64,TEST"})
        self.image_fetch = patcher.start()
        self.addCleanup(patcher.stop)

    def test_tavily_images_become_visual_context_without_another_tool_or_sandbox(self, _key):
        with patch("tavily.TavilyClient") as client, patch("sandbox.services.sandbox_service.SandboxBootstrapService.conversation_project") as project:
            client.return_value.search.return_value = {
                "results": [{"url": "https://example.com/article", "content": "Source evidence"}],
                "images": [{"url": "https://example.com/photo.jpg", "description": "A tower"}],
            }
            result = json.loads(execute_builtin_tool(Mock(), "image_search", {"query": "tower"}, conversation=SimpleNamespace(uuid="chat")))
        project.assert_not_called()
        client.return_value.search.assert_called_once()
        kwargs = client.return_value.search.call_args.kwargs
        self.assertTrue(kwargs["include_images"])
        self.assertTrue(kwargs["include_image_descriptions"])
        self.assertEqual(kwargs["search_depth"], "basic")
        self.assertFalse(kwargs["auto_parameters"])
        self.assertEqual(result["results"][0]["snippet"], "Source evidence")
        context = image_context_from_tools([{"name": "image_search", "result": result}])
        self.assertEqual(context["content"][1]["image_url"]["url"], "data:image/jpeg;base64,TEST")
        self.assertIn("A tower", context["content"][0]["text"])
        self.assertIn("not as instructions", context["content"][0]["text"])

    def test_image_normalization_deduplicates_filters_and_bounds_visual_context(self, _key):
        raw = [None, {}, "file:///secret", "data:image/png;base64,AA", "https:///missing-host", "https://[", 1]
        raw += [{"url": "https://example.com/0.jpg", "description": "x" * 2000}, "https://example.com/0.jpg"]
        raw += [f"https://example.com/{i}.jpg" for i in range(1, 20)]
        with patch("tavily.TavilyClient") as client:
            client.return_value.search.return_value = {"results": [], "images": raw}
            result = handle(None, {"query": "photos"})
        self.assertEqual(result["image_count"], 8)
        self.assertEqual(len(result["images"][0]["description"]), 1500)
        self.assertEqual([image["image_url"] for image in result["images"]], [f"https://example.com/{i}.jpg" for i in range(8)])

    def test_batch_preserves_successful_images_when_another_query_fails(self, _key):
        started = Barrier(2, timeout=3)

        def search(**kwargs):
            started.wait()
            if kwargs["query"] == "failed":
                raise TimeoutError("upstream timeout")
            return {"results": [], "images": ["https://example.com/photo.jpg"]}

        with patch("tavily.TavilyClient") as client:
            client.return_value.search.side_effect = search
            result = handle(None, {"queries": ["photos", "failed"]})
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["image_count"], 1)
        self.assertEqual(result["images"][0]["query"], "photos")
        self.assertIn("error", result["searches"][1])
        self.assertIsNotNone(image_context_from_tools([{"name": "image_search", "result": result}]))

    def test_empty_failed_and_invalid_searches_do_not_attach_images(self, _key):
        with patch("tavily.TavilyClient") as client:
            client.return_value.search.return_value = {"results": []}
            empty = handle(None, {"query": "no images"})
            self.assertEqual(empty["image_count"], 0)
            self.assertIn("No images", empty["message"])
            client.return_value.search.side_effect = TimeoutError("timeout")
            failed = handle(None, {"query": "failed"})
            self.assertIn("error", failed)
            self.assertIn("error", handle(None, {"queries": []}))
        for result in (empty, failed):
            self.assertIsNone(image_context_from_tools([{"name": "image_search", "result": result}]))

    @patch("chat.services.chat_service.get_all_warm_models", return_value=[])
    def test_all_generation_paths_receive_search_images_in_the_next_request(self, _warm, _key):
        from chat.tests.test_unlimited_tool_rounds import UnlimitedToolRoundTests

        for streaming in (True, False):
            for external in (True, False):
                with self.subTest(streaming=streaming, external=external):
                    service = UnlimitedToolRoundTests().service(external)
                    call = {"id": "images", "function": {"name": "image_search", "arguments": '{"query":"tower"}'}}
                    self.assertTrue(is_parallel_web_read(call))
                    model_calls = 0

                    def response():
                        nonlocal model_calls
                        model_calls += 1
                        if model_calls == 1:
                            return "", None, 1, 2, [call]
                        self.assertEqual([m["role"] for m in service.messages], ["assistant", "tool", "user"])
                        self.assertEqual(service.messages[-1]["content"][1]["image_url"]["url"], "data:image/jpeg;base64,TEST")
                        return "Tower found", None, 1, 2, []

                    def stream(*args):
                        if False:
                            yield
                        content, thinking, input_tokens, output_tokens, calls = response()
                        if external:
                            return content, thinking, input_tokens, output_tokens, calls, 0
                        return content, input_tokens, output_tokens, thinking, calls, 0

                    service._stream_external = service._stream_local = stream
                    service._generate_external_sync = service._generate_local_sync = response
                    with patch("tavily.TavilyClient") as client, patch("sandbox.services.sandbox_service.SandboxBootstrapService.conversation_project") as project:
                        client.return_value.search.return_value = {"results": [], "images": ["https://example.com/photo.jpg"]}
                        if streaming:
                            list(service._generate_stream_events())
                        else:
                            self.assertEqual(service.generate_sync()["response"], "Tower found")
                    project.assert_not_called()
                    client.return_value.search.assert_called_once()
                    self.assertEqual(model_calls, 2)
                    saved = service._save_response.call_args.kwargs["tool_calls"]
                    self.assertEqual([tool["function"]["name"] for tool in saved], ["image_search"])
                    self.assertEqual(saved[0]["result"]["image_count"], 1)


class ImageSearchHistoryTests(TestCase):
    def test_saved_search_images_are_restored_for_followup_turns(self):
        user = get_user_model().objects.create_user(username="image-search-user", email="image-search@example.com")
        conversation = Conversation.objects.create(user=user)
        first = Message.objects.create(conversation=conversation, role="user", content="Find a tower")
        result = {"status": "ok", "images": [{"status": "ok", "image_url": "https://example.com/tower.jpg", "source": "https://example.com/tower.jpg", "description": "Tower", "query": "tower"}]}
        reply = Message.objects.create(conversation=conversation, role="assistant", parent=first, content="Found it", tool_calls=[{"function": {"name": "image_search"}, "result": result}])
        followup = Message.objects.create(conversation=conversation, role="user", parent=reply, content="What color is it?")
        history = build_parent_chain(followup)
        self.assertEqual(history[2]["content"][1]["image_url"]["url"], "https://example.com/tower.jpg")
        self.assertEqual(history[-1]["content"], "What color is it?")

    def test_current_schema_is_exposed_once_without_waiting_for_migration(self):
        Tool.objects.update_or_create(name="image_search", defaults={"description": "Old schema", "parameters_schema": {}, "enabled": True})
        service = ChatService.__new__(ChatService)
        service.tools = [IMAGE_SEARCH_TOOL]
        service._get_mcp_tools = lambda: []
        tools = [t for t in service._merge_mcp_tools() if t["function"]["name"] == "image_search"]
        self.assertEqual(tools, [IMAGE_SEARCH_TOOL])
