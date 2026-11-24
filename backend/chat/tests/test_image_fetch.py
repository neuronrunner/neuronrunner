from io import BytesIO
import socket
import struct
import zlib
from unittest.mock import Mock, patch

from django.test import SimpleTestCase
from PIL import Image
import requests

from chat.tools.image_fetch import fetch_image, MAX_DOWNLOAD_BYTES, _PublicHTTPConnection
from chat.tools.image_search import handle
from chat.tools.display_image import model_tool_result
from chat.tools.view_image import image_context_from_tools


class ImageFetchTests(SimpleTestCase):
    def setUp(self):
        self.public = patch("chat.tools.image_fetch.socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
        self.public.start()
        self.addCleanup(self.public.stop)
        self.session = Mock()
        self.session.__enter__ = Mock(return_value=self.session)
        self.session.__exit__ = Mock(return_value=False)
        patcher = patch("chat.tools.image_fetch.requests.Session", return_value=self.session)
        patcher.start()
        self.addCleanup(patcher.stop)
        content = BytesIO()
        Image.new("RGB", (20, 10), "pink").save(content, "PNG")
        self.bytes = content.getvalue()

    def response(self, status=200, content=None, headers=None):
        response = Mock(status_code=status, headers=headers or {})
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = [self.bytes if content is None else content]
        if status >= 400:
            response.raise_for_status.side_effect = requests.HTTPError(f"HTTP {status}")
        return response

    def test_verified_bytes_are_attached_without_provider_refetching_remote_url(self):
        self.session.get.return_value = self.response()
        result = fetch_image("https://example.com/photo.png")
        self.assertEqual(result["status"], "ok")
        self.assertEqual((result["width"], result["height"]), (20, 10))
        self.assertTrue(result["context_url"].startswith("data:image/jpeg;base64,"))
        search_result = {"images": [{"source": "https://example.com/photo.png", **result}]}
        context = image_context_from_tools([{"name": "image_search", "result": search_result}])
        self.assertEqual(context["content"][1]["image_url"]["url"], result["context_url"])
        text = model_tool_result("image_search", search_result)
        self.assertNotIn("context_url", text["images"][0])
        self.assertIn("context_url", search_result["images"][0])

    def test_http_errors_and_non_images_are_explicit_failures(self):
        for response in [self.response(status=403), self.response(content=b"<html>Not an image</html>")]:
            with self.subTest(response=response):
                self.session.get.return_value = response
                result = fetch_image("https://example.com/photo.jpg")
                self.assertEqual(result["status"], "error")
                self.assertIn("error", result)
                self.assertNotIn("context_url", result)

    def test_private_hosts_and_redirects_are_rejected_before_fetch(self):
        for url in ["http://127.0.0.1/photo.jpg", "http://169.254.169.254/latest", "https://example.com:9000/photo.jpg"]:
            with self.subTest(url=url), patch("chat.tools.image_fetch.socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]):
                self.assertEqual(fetch_image(url)["status"], "error")
        self.session.get.assert_not_called()
        self.session.get.return_value = self.response(status=302, headers={"Location": "http://127.0.0.1/private"})
        with patch("chat.tools.image_fetch.socket.getaddrinfo", side_effect=[[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))], [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]]):
            self.assertEqual(fetch_image("https://example.com/photo.jpg")["status"], "error")
        self.assertEqual(self.session.get.call_count, 1)

    def test_rebound_private_address_is_rejected_at_connection_time(self):
        with patch("chat.tools.image_fetch.socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]), patch("chat.tools.image_fetch.socket.socket") as connect:
            with self.assertRaisesRegex(ValueError, "public address"):
                _PublicHTTPConnection("example.com", port=80, timeout=1)._new_conn()
        connect.assert_not_called()

    def test_declared_and_streamed_download_size_limits_are_enforced(self):
        for response in [self.response(headers={"Content-Length": str(MAX_DOWNLOAD_BYTES + 1)}), self.response(content=b"x" * (MAX_DOWNLOAD_BYTES + 1))]:
            with self.subTest(response=response):
                self.session.get.return_value = response
                self.assertIn("5 MB", fetch_image("https://example.com/photo.jpg")["error"])

    def test_timeout_is_an_image_error(self):
        self.session.get.side_effect = requests.Timeout("download timed out")
        self.assertIn("timed out", fetch_image("https://example.com/photo.jpg")["error"])

    def test_large_pixel_dimensions_are_rejected_before_decoding(self):
        content = bytearray(self.bytes)
        content[16:24] = struct.pack(">II", 5000, 5000)
        content[29:33] = struct.pack(">I", zlib.crc32(content[12:29]))
        self.session.get.return_value = self.response(content=bytes(content))
        with patch("PIL.PngImagePlugin.PngImageFile.load") as decode:
            self.assertIn("12 megapixel", fetch_image("https://example.com/large.png")["error"])
        decode.assert_not_called()


class ImageSearchRecoveryTests(SimpleTestCase):
    def test_queries_share_slots_and_failed_images_get_replacements(self):
        searches = [{"query": str(q), "images": [{"url": f"https://example.com/{q}-{i}.jpg"} for i in range(6)]} for q in range(4)]
        def fetch(url):
            return {"status": "error", "error": "HTTP 403"} if url.endswith("0-0.jpg") else {"status": "ok", "image_url": url, "context_url": "data:image/jpeg;base64,AA"}
        with patch("chat.tools.image_search.search_web", return_value={"status": "ok", "count": 24, "searches": searches}), patch("chat.tools.image_search.fetch_image", side_effect=fetch) as opened:
            result = handle(None, {"queries": ["0", "1", "2", "3"]})
        self.assertEqual(result["image_count"], 8)
        self.assertEqual(result["status"], "partial")
        self.assertEqual({image["query"] for image in result["images"]}, {"0", "1", "2", "3"})
        self.assertEqual(result["image_errors"][0]["error"], "HTTP 403")
        self.assertEqual(opened.call_count, 9)

    def test_all_image_failures_do_not_claim_images_were_attached(self):
        with patch("chat.tools.image_search.search_web", return_value={"status": "ok", "count": 0, "images": ["https://example.com/broken.jpg"]}), patch("chat.tools.image_search.fetch_image", return_value={"status": "error", "error": "HTTP 403"}):
            result = handle(None, {"query": "photos"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["image_count"], 0)
        self.assertIsNone(image_context_from_tools([{"name": "image_search", "result": result}]))
        self.assertIn("No images could be opened", result["message"])
