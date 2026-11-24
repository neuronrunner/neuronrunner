from types import SimpleNamespace
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from mcp.throttle import MCPGlobalRateThrottle, MCPServerRateThrottle


def request(*, user=None):
    return SimpleNamespace(
        method="POST",
        path="/mcp/execute/",
        data={"tool_name": "mcp__server__tool"},
        user=user or SimpleNamespace(is_authenticated=False, uuid=""),
        META={},
    )


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class MCPThrottleTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    @patch("mcp.throttle.time.time", return_value=1000.0)
    def test_server_limit_is_shared_across_instances_and_resets_next_window(self, _time):
        first = MCPServerRateThrottle()
        second = MCPServerRateThrottle()
        with patch.object(first, "_get_server_id", return_value="server-1"), \
                patch.object(first, "_get_rate_limit", return_value=(10.0, 20)), \
                patch.object(second, "_get_server_id", return_value="server-1"), \
                patch.object(second, "_get_rate_limit", return_value=(10.0, 20)):
            self.assertTrue(all(first.allow_request(request(), None) for _ in range(20)))
            self.assertFalse(second.allow_request(request(), None))
            with patch("mcp.throttle.time.time", return_value=1001.0):
                self.assertTrue(second.allow_request(request(), None))

    @patch("mcp.throttle.time.time", return_value=1000.0)
    def test_global_limit_is_per_user(self, _time):
        throttle = MCPGlobalRateThrottle()
        user = SimpleNamespace(is_authenticated=True, uuid="user-1")
        other = SimpleNamespace(is_authenticated=True, uuid="user-2")
        self.assertTrue(all(throttle.allow_request(request(user=user), None) for _ in range(100)))
        self.assertFalse(throttle.allow_request(request(user=user), None))
        self.assertTrue(throttle.allow_request(request(user=other), None))

    def test_requests_without_a_server_are_not_limited(self):
        throttle = MCPServerRateThrottle()
        with patch.object(throttle, "_get_server_id", return_value=None):
            self.assertTrue(all(throttle.allow_request(request(), None) for _ in range(200)))
