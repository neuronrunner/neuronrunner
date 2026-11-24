from unittest.mock import MagicMock, patch
from django.test import RequestFactory, SimpleTestCase
from django.db.utils import OperationalError
from django.http import HttpResponse

from app.db_retry_middleware import DatabaseWarmupMiddleware, is_warmup_error


class DatabaseWarmupMiddlewareTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_is_warmup_error_detection(self):
        self.assertTrue(is_warmup_error(OperationalError("FATAL: the database system is starting up")))
        self.assertTrue(is_warmup_error(OperationalError("server closed the connection unexpectedly")))
        self.assertTrue(is_warmup_error(OperationalError("connection to server at 1.2.3.4 failed: connection refused")))
        self.assertFalse(is_warmup_error(OperationalError("syntax error at or near 'SELECT'")))
        self.assertFalse(is_warmup_error(ValueError("Invalid argument")))

    @patch("time.sleep", return_value=None)
    def test_sync_retry_succeeds_after_transient_startup_error(self, mock_sleep):
        request = self.factory.get("/")
        call_count = 0

        def view(req):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise OperationalError("FATAL: the database system is starting up")
            return HttpResponse("Success")

        middleware = DatabaseWarmupMiddleware(view)
        response = middleware(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"Success")
        self.assertEqual(call_count, 3)
        self.assertEqual(mock_sleep.call_count, 2)

    @patch("time.sleep", return_value=None)
    def test_sync_reraises_non_warmup_error_immediately(self, mock_sleep):
        request = self.factory.get("/")

        def view(req):
            raise OperationalError("relation does not exist")

        middleware = DatabaseWarmupMiddleware(view)
        with self.assertRaises(OperationalError) as ctx:
            middleware(request)

        self.assertIn("relation does not exist", str(ctx.exception))
        self.assertEqual(mock_sleep.call_count, 0)

    @patch("asyncio.sleep", return_value=None)
    async def test_async_retry_succeeds_after_transient_startup_error(self, mock_sleep):
        request = self.factory.get("/")
        call_count = 0

        async def async_view(req):
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise OperationalError("connection to server at 'db' failed: connection refused")
            return HttpResponse("Async Success")

        middleware = DatabaseWarmupMiddleware(async_view)
        response = await middleware(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"Async Success")
        self.assertEqual(call_count, 2)
        self.assertEqual(mock_sleep.call_count, 1)
