import base64
from importlib import import_module
from io import BytesIO
import json
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.apps import apps
from django.test import TestCase, override_settings
from PIL import Image

from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation, Message, Tool
from chat.services.chat_service import ChatService
from chat.services.utils import build_parent_chain
from chat.tools.display_image import model_tool_result
from chat.tools.view_image import VIEW_IMAGE_TOOL, image_context_from_tools
from sandbox.models import Sandbox
from sandbox.services import workspace_disk_guest
from sandbox.services.sandbox_service import SandboxBootstrapService
from sandbox.services.git_service import get_shared_workspace_root


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class ViewImageTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="view-user", email="view@example.com")
        self.directory = self.enterContext(TemporaryDirectory())
        self.enterContext(override_settings(LOCAL_WORKSPACE_ROOT=self.directory))
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.root = SandboxBootstrapService.ensure_workspace_sandbox(self.workspace)
        self.conversation = Conversation.objects.create(user=self.user)
        self.root.conversations.add(self.conversation)
        buffer = BytesIO()
        Image.new("RGB", (32, 24), "red").save(buffer, "PNG")
        self.bytes = buffer.getvalue()
        disk = get_shared_workspace_root(self.root)
        disk.mkdir(parents=True, exist_ok=True)
        (disk / "photo.png").write_bytes(self.bytes)
        runtime = Mock()

        def execute(*command, **kwargs):
            request = json.loads(command[-1])
            request["root"] = str(disk / request["root"].removeprefix("/workspace").lstrip("/"))
            try:
                with patch.object(workspace_disk_guest, "WORKSPACE_ROOT", disk), patch.object(workspace_disk_guest.sys, "stdin", SimpleNamespace(buffer=BytesIO(kwargs.get("stdin", b"")))):
                    result = workspace_disk_guest.operate(request)
            except (ValueError, OSError) as exc:
                result = {"error": str(exc)}
            proc = Mock()
            proc.stdout.read.return_value = json.dumps(result)
            proc.wait.return_value = 0
            return proc

        runtime.exec.side_effect = execute
        self.manager = self.enterContext(patch("sandbox.services.sandbox_session.get_sandbox_manager"))
        self.manager.return_value.get_or_create.return_value = runtime

    def view(self, source, **args):
        return json.loads(execute_builtin_tool(self.user, "view_image", {"source": source, **args}, self.conversation))

    def view_many(self, sources):
        return json.loads(execute_builtin_tool(self.user, "view_image", {"sources": sources}, self.conversation))

    def test_batch_opens_workspace_and_remote_images_in_source_order(self):
        with patch("requests.request") as request:
            result = self.view_many(["photo.png", "https://example.com/second.jpg"])
            request.assert_not_called()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["count"], 2)
        self.assertEqual([image["source"] for image in result["images"]], ["/workspace/photo.png", "https://example.com/second.jpg"])
        self.assertEqual(base64.b64decode(result["images"][0]["image_url"].split(",", 1)[1]), self.bytes)
        context = image_context_from_tools([{"name": "view_image", "result": result}])
        self.assertEqual(len(context["content"]), 4)
        self.assertEqual([part["image_url"]["url"] for part in context["content"] if part["type"] == "image_url"], [image["image_url"] for image in result["images"]])
        self.assertIn("/workspace/photo.png", context["content"][0]["text"])
        self.assertIn("https://example.com/second.jpg", context["content"][2]["text"])

    def test_batch_failure_keeps_successful_images_and_reports_failed_source(self):
        result = self.view_many(["missing.png", "photo.png", "/etc/passwd", "https://example.com/second.jpg"])
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["images"][0]["source"], "missing.png")
        self.assertIn("error", result["images"][0])
        self.assertIn("error", result["images"][2])
        self.assertNotIn("error", result)
        context = image_context_from_tools([{"name": "view_image", "result": result}])
        self.assertEqual(len(context["content"]), 4)
        self.assertIn("/workspace/photo.png", context["content"][0]["text"])
        failed = self.view_many(["missing.png", "/etc/passwd"])
        self.assertEqual(failed["count"], 0)
        self.assertIn("error", failed)
        self.assertIsNone(image_context_from_tools([{"name": "view_image", "result": failed}]))

    def test_batch_validation_rejects_invalid_sources_before_reading_files(self):
        arguments = [{"sources": []}, {"sources": "photo.png"}, {"sources": ["photo.png"] * 9}, {"sources": ["photo.png", None]}, {"sources": [" "]}, {"sources": ["photo.png"], "source": "photo.png"}]
        with patch("chat.tools.view_image.handle_display_image") as read:
            for args in arguments:
                with self.subTest(args=args):
                    result = json.loads(execute_builtin_tool(self.user, "view_image", args, self.conversation))
                    self.assertIn("error", result)
            read.assert_not_called()

    def test_batch_pixels_stay_out_of_tool_text_without_mutating_saved_result(self):
        result = self.view_many(["photo.png", "https://example.com/second.jpg"])
        text = model_tool_result("view_image", result)
        self.assertNotIn("base64", json.dumps(text))
        self.assertTrue(all("image_url" not in image for image in text["images"]))
        self.assertTrue(all("image_url" in image for image in result["images"]))
        self.assertEqual(text["count"], 2)

    def test_batch_images_are_restored_in_followup_context(self):
        result = self.view_many(["photo.png", "https://example.com/second.jpg"])
        first = Message.objects.create(conversation=self.conversation, role="user", content="Compare these")
        reply = Message.objects.create(conversation=self.conversation, role="assistant", parent=first, content="Comparison", tool_calls=[{"function": {"name": "view_image"}, "result": result}])
        followup = Message.objects.create(conversation=self.conversation, role="user", parent=reply, content="Which is red?")
        context = build_parent_chain(followup)[2]
        self.assertEqual(len(context["content"]), 4)
        self.assertEqual(context["content"][3]["image_url"]["url"], result["images"][1]["image_url"])

    def test_workspace_photo_becomes_visual_context_without_new_project(self):
        before = Sandbox.objects.count()
        result = self.view("/workspace/photo.png")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(base64.b64decode(result["image_url"].split(",", 1)[1]), self.bytes)
        self.assertEqual((result["width"], result["height"]), (32, 24))
        self.assertEqual(Sandbox.objects.count(), before)
        self.assertNotIn("return_type", result)
        context = image_context_from_tools([{"function": {"name": "view_image"}, "result": result}])
        self.assertEqual(context["content"][1]["image_url"]["url"], result["image_url"])

    def test_remote_photo_is_image_url_without_backend_http_fetch(self):
        with patch("requests.request") as request:
            result = self.view("https://example.com/photo.jpg")
            request.assert_not_called()
        self.assertEqual(result["image_url"], "https://example.com/photo.jpg")
        self.assertNotIn("Image sent to the chat UI", result["message"])

    def test_pixels_are_not_serialized_as_tool_text_or_counted_as_base64_tokens(self):
        result = self.view("photo.png")
        text = model_tool_result("view_image", result)
        self.assertNotIn("image_url", text)
        self.assertNotIn("base64", json.dumps(text))
        service = ChatService.__new__(ChatService)
        message = {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + "A" * 100000}}]}
        self.assertLess(service._estimate_message_tokens(message), 1100)

    def test_image_context_is_restored_for_followup_messages(self):
        result = self.view("photo.png")
        first = Message.objects.create(conversation=self.conversation, role="user", content="Inspect the photo")
        reply = Message.objects.create(conversation=self.conversation, role="assistant", parent=first, content="It is red", tool_calls=[{"function": {"name": "view_image"}, "result": result}])
        followup = Message.objects.create(conversation=self.conversation, role="user", parent=reply, content="What else can you see?")
        history = build_parent_chain(followup)
        self.assertEqual([message["role"] for message in history], ["user", "assistant", "user", "user"])
        self.assertEqual(history[2]["content"][1]["image_url"]["url"], result["image_url"])
        self.assertEqual(history[-1]["content"], "What else can you see?")

    def test_paths_and_unattached_context_cannot_expose_other_files(self):
        for source in ["/etc/passwd", "../secret.png", "missing.png", "file:///etc/passwd"]:
            self.assertIn("error", self.view(source))
        forged = execute_builtin_tool(self.user, "view_image", {"source": "/workspace/photo.png", "_sandbox_uuid": str(self.root.uuid)})
        self.assertIn("error", json.loads(forged))
        self.assertIsNone(image_context_from_tools([{"name": "view_image", "result": {"error": "not found"}}]))

    def test_tool_is_exposed_once_even_with_database_and_incoming_schema(self):
        Tool.objects.create(name="view_image", description="Inspect", parameters_schema={}, enabled=True, is_builtin=True)
        service = ChatService.__new__(ChatService)
        service.conversation = self.conversation
        service.tools = [VIEW_IMAGE_TOOL]
        service._get_mcp_tools = lambda: []
        self.assertEqual([tool["function"]["name"] for tool in service._merge_mcp_tools()].count("view_image"), 1)

    @patch("chat.services.chat_service.get_all_warm_models", return_value=[])
    def test_both_tool_loops_attach_photo_after_all_tool_results(self, _warm):
        from chat.tests.test_unlimited_tool_rounds import UnlimitedToolRoundTests
        result = self.view_many(["photo.png", "https://example.com/second.jpg"])
        for streaming in [True, False]:
            with self.subTest(streaming=streaming):
                service = UnlimitedToolRoundTests().service()
                calls = 0
                def response():
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        return "", None, 1, 2, [
                            {"id": "view", "function": {"name": "view_image", "arguments": '{"sources":["photo.png","https://example.com/second.jpg"]}'}},
                            {"id": "other", "function": {"name": "file_read", "arguments": '{"path":"README.md"}'}},
                        ]
                    self.assertEqual([message["role"] for message in service.messages], ["assistant", "tool", "tool", "user"])
                    self.assertNotIn("base64", service.messages[1]["content"])
                    self.assertEqual(service.messages[-1]["content"][1]["image_url"]["url"], result["images"][0]["image_url"])
                    self.assertEqual(service.messages[-1]["content"][3]["image_url"]["url"], result["images"][1]["image_url"])
                    return "Image inspected", None, 1, 2, []
                def model(*args):
                    if False:
                        yield
                    return (*response(), 0)
                def tool(user, name, *args, **kwargs):
                    return json.dumps(result if name == "view_image" else {"content": "readme"})
                service._stream_external = model
                service._generate_external_sync = response
                with patch("chat.builtin_tools.execute_builtin_tool", side_effect=tool), patch("chat.builtin_tools.execute_builtin_tool_stream", side_effect=lambda *args, **kwargs: iter([("result", tool(*args, **kwargs))])):
                    if streaming:
                        list(service._generate_stream_events())
                    else:
                        service.generate_sync()
                self.assertEqual(calls, 2)
                self.assertEqual(service._save_response.call_args.args[0], "Image inspected")
