import base64
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from PIL import Image
from rest_framework.test import APIClient

from chat.builtin_tools import execute_builtin_tool
from chat.models import Conversation
from chat.models import Tool
from chat.tools.display_image import handle_display_image, model_tool_result
from sandbox.models import Sandbox
from sandbox.services import workspace_disk_guest
from sandbox.services.sandbox_service import SandboxBootstrapService
from sandbox.services.git_service import get_shared_workspace_root


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class DisplayImageTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="image-preview-user", email="preview@example.com")
        self.directory = self.enterContext(TemporaryDirectory())
        self.enterContext(override_settings(LOCAL_WORKSPACE_ROOT=self.directory))
        self.workspace = SandboxBootstrapService.ensure_personal_workspace(self.user)
        self.root = SandboxBootstrapService.ensure_workspace_sandbox(self.workspace)
        self.project = Sandbox.objects.create(user=self.user, workspace=self.workspace, slug="website", display_name="Website", filesystem_path="/workspace/website")
        self.conversation = Conversation.objects.create(user=self.user)
        self.project.conversations.add(self.conversation)
        self.disk_root = get_shared_workspace_root(self.root)
        runtime = Mock()

        def execute(*command, **kwargs):
            request = json.loads(command[-1])
            request["root"] = str(self.disk_root / request["root"].removeprefix("/workspace").lstrip("/"))
            with patch.object(workspace_disk_guest, "WORKSPACE_ROOT", self.disk_root), patch.object(workspace_disk_guest.sys, "stdin", SimpleNamespace(buffer=BytesIO(kwargs.get("stdin", b"")))):
                result = workspace_disk_guest.operate(request)
            proc = Mock()
            proc.stdout.read.return_value = json.dumps(result)
            proc.wait.return_value = 0
            return proc

        runtime.exec.side_effect = execute
        self.manager = self.enterContext(patch("sandbox.services.sandbox_session.get_sandbox_manager"))
        self.manager.return_value.get_or_create.return_value = runtime

    def show(self, source, **arguments):
        return json.loads(execute_builtin_tool(self.user, "display_image", {"source": source, **arguments}, conversation=self.conversation))

    def image_file(self, filename, format="PNG"):
        buffer = BytesIO()
        Image.new("RGB", (23, 17), "red").save(buffer, format=format)
        target = self.disk_root / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(buffer.getvalue())
        return buffer.getvalue()

    def test_remote_link_needs_no_workspace_and_never_fetches_or_starts_runtime(self):
        with patch("sandbox.services.volume_tools.read_file") as read:
            result = json.loads(execute_builtin_tool(self.user, "display_image", {"source": "HTTPS://example.com/image?token=abc", "title": "Reference"}))
        self.assertEqual(result["content_url"], "https://example.com/image?token=abc")
        self.assertEqual(result["title"], "Reference")
        self.assertEqual(result["return_type"], "image")
        read.assert_not_called()
        self.manager.assert_not_called()

    def test_absolute_png_and_relative_jpeg_preserve_original_bytes_and_workspace(self):
        for filename, source, format, mime in [
            ("website/çalışma.png", "/workspace/website/çalışma.png", "PNG", "image/png"),
            ("website/photo.jpg", "photo.jpg", "JPEG", "image/jpeg"),
        ]:
            original = self.image_file(filename, format)
            before = Sandbox.objects.count()
            result = self.show(source, title="Preview")
            self.assertNotIn("error", result)
            self.assertEqual(result["mime"], mime)
            self.assertEqual((result["width"], result["height"]), (23, 17))
            self.assertEqual(base64.b64decode(result["content_url"].split(",", 1)[1]), original)
            self.assertEqual(Sandbox.objects.count(), before)

    def test_missing_invalid_outside_and_symlink_files_do_not_expose_disk_data(self):
        self.assertIn("not found", self.show("missing.png")["error"])
        (self.disk_root / "website").mkdir()
        (self.disk_root / "website" / "text.png").write_text("not an image")
        self.assertIn("not a valid image", self.show("text.png")["error"])
        self.assertIn("error", self.show("/etc/passwd"))
        self.assertIn("error", self.show("../../outside.png"))
        outside = Path(self.directory) / "outside.png"
        outside.write_bytes(b"private")
        (self.disk_root / "website" / "link.png").symlink_to(outside)
        self.assertIn("current workspace", self.show("link.png")["error"])

    def test_local_image_requires_authorized_conversation_context(self):
        self.assertIn("error", json.loads(execute_builtin_tool(self.user, "display_image", {"source": "/workspace/photo.png", "sandbox_uuid": str(self.root.uuid), "_sandbox_uuid": str(self.root.uuid)})))
        stranger = get_user_model().objects.create_user(username="image-stranger", email="stranger@example.com")
        self.assertIn("error", handle_display_image(stranger, {"source": "/workspace/photo.png", "_sandbox_uuid": str(self.root.uuid)}))

    def test_inline_image_bytes_are_not_sent_to_model_context(self):
        self.image_file("website/chart.png")
        result = self.show("chart.png")
        summary = model_tool_result("display_image", result)
        self.assertNotIn("content_url", summary)
        self.assertEqual(summary["path"], "/workspace/website/chart.png")
        self.assertIn("content_url", result)
        self.assertEqual(model_tool_result("other_tool", result), result)

    def test_unsafe_url_schemes_and_oversize_images_return_errors(self):
        for source in ["file:///etc/passwd", "javascript:alert(1)", "https://", "//example.com/image.png", "data:image/png;base64,AAAA"]:
            self.assertIn("error", self.show(source))
        self.image_file("website/chart.png")
        with patch("chat.tools.display_image.MAX_IMAGE_BYTES", 5):
            self.assertIn("preview limit", self.show("chart.png")["error"])

    def test_markdown_preview_endpoint_reads_workspace_image_without_tool_execution(self):
        original = self.image_file("website/chart.png")
        client = APIClient()
        client.force_authenticate(self.user)
        response = client.get(f"/sandbox/sandboxes/{self.root.uuid}/image-preview/", {"path": "/workspace/website/chart.png"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(base64.b64decode(response.data["content_url"].split(",", 1)[1]), original)

    def test_markdown_preview_endpoint_rejects_other_workspaces_and_outside_paths(self):
        client = APIClient()
        client.force_authenticate(self.user)
        response = client.get(f"/sandbox/sandboxes/{self.root.uuid}/image-preview/", {"path": "/etc/passwd"})
        self.assertEqual(response.status_code, 400)
        stranger = get_user_model().objects.create_user(username="markdown-stranger", email="markdown-stranger@example.com")
        client.force_authenticate(stranger)
        response = client.get(f"/sandbox/sandboxes/{self.root.uuid}/image-preview/", {"path": "/workspace/photo.png"})
        self.assertEqual(response.status_code, 404)
