from datetime import timedelta
from unittest.mock import Mock, patch

from django.test import TestCase
from django.utils import timezone

from chat.constants import GENERATION_CANCELED_ERROR
from chat.models import Request
from chat.services.request_heartbeat import RequestHeartbeat
from chat.views.serializers import maybe_mark_request_timed_out


class RequestTimeoutTests(TestCase):
    def request(self, **kwargs):
        request = Request.objects.create(status="processing", started_at=timezone.now())
        Request.objects.filter(pk=request.pk).update(started_at=timezone.now() - timedelta(hours=2), **kwargs)
        request.refresh_from_db()
        return request

    def test_live_worker_can_run_for_hours_without_being_failed(self):
        request = self.request(last_activity_at=timezone.now() - timedelta(seconds=30))
        self.assertFalse(maybe_mark_request_timed_out(request))
        request.refresh_from_db()
        self.assertEqual(request.status, "processing")

    def test_abandoned_worker_is_failed_after_ten_minutes_without_heartbeat(self):
        request = self.request(last_activity_at=timezone.now() - timedelta(minutes=11))
        self.assertTrue(maybe_mark_request_timed_out(request))
        request.refresh_from_db()
        self.assertEqual(request.status, "failed")
        self.assertIn("without a worker heartbeat", request.error_message)
        self.assertGreater(request.duration_seconds, 7100)

    def test_old_requests_without_heartbeat_still_time_out(self):
        self.assertTrue(maybe_mark_request_timed_out(self.request()))

    def test_pending_request_timeout_is_preserved(self):
        request = Request.objects.create()
        Request.objects.filter(pk=request.pk).update(created_at=timezone.now() - timedelta(minutes=6))
        request.refresh_from_db()
        self.assertTrue(maybe_mark_request_timed_out(request))
        self.assertIn("pending without starting", request.error_message)

    def test_recent_heartbeat_wins_against_stale_poll(self):
        stale = self.request(last_activity_at=timezone.now() - timedelta(minutes=11))
        self.assertTrue(RequestHeartbeat(Request.objects.get(pk=stale.pk)).pulse())
        self.assertFalse(maybe_mark_request_timed_out(stale))
        self.assertEqual(stale.status, "processing")

    def test_completion_wins_against_stale_poll(self):
        stale = self.request()
        Request.objects.filter(pk=stale.pk).update(status="completed")
        self.assertFalse(maybe_mark_request_timed_out(stale))
        self.assertEqual(stale.status, "completed")

    def test_canceled_request_is_not_timed_out_or_revived(self):
        request = self.request(error_message=GENERATION_CANCELED_ERROR)
        self.assertFalse(maybe_mark_request_timed_out(request))
        Request.objects.filter(pk=request.pk).update(status="canceled")
        self.assertFalse(RequestHeartbeat(request).pulse())

    def test_heartbeat_starts_immediately_and_stops_with_worker(self):
        request = self.request()
        thread = Mock()
        with patch("chat.services.request_heartbeat.Thread", return_value=thread):
            with RequestHeartbeat(request) as heartbeat:
                request.refresh_from_db()
                self.assertIsNotNone(request.last_activity_at)
                thread.start.assert_called_once()
                self.assertFalse(heartbeat.stop.is_set())
            self.assertTrue(heartbeat.stop.is_set())
            thread.join.assert_called_once_with(timeout=1)

    def test_heartbeat_continues_during_silent_model_or_tool_call(self):
        heartbeat = RequestHeartbeat(self.request())
        with patch.object(heartbeat.stop, "wait", side_effect=[False, False, True]), patch.object(heartbeat, "pulse", return_value=True) as pulse:
            heartbeat._run()
        self.assertEqual(pulse.call_count, 2)

    def test_worker_heartbeat_ends_when_request_is_finalized(self):
        heartbeat = RequestHeartbeat(self.request())
        with patch.object(heartbeat.stop, "wait", return_value=False), patch.object(heartbeat, "pulse", return_value=False) as pulse:
            heartbeat._run()
        pulse.assert_called_once()
