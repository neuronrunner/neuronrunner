"""Keep live generation workers distinguishable from abandoned requests."""
import logging
from threading import Event, Thread

from django.db import close_old_connections
from django.utils import timezone

from chat.models import Request

logger = logging.getLogger(__name__)
HEARTBEAT_INTERVAL_SECONDS = 30


class RequestHeartbeat:
    def __init__(self, request):
        self.request = request
        self.stop = Event()
        self.thread = None

    def pulse(self):
        now = timezone.now()
        updated = Request.objects.filter(pk=self.request.pk, status__in=("pending", "processing")).update(last_activity_at=now)
        if updated:
            self.request.last_activity_at = now
        return bool(updated)

    def _run(self):
        try:
            while not self.stop.wait(HEARTBEAT_INTERVAL_SECONDS):
                close_old_connections()
                try:
                    if not self.pulse():
                        break
                except Exception:
                    logger.exception("Could not update heartbeat for request %s", self.request.pk)
        finally:
            close_old_connections()

    def __enter__(self):
        if isinstance(self.request, Request) and self.request.pk and self.pulse():
            self.thread = Thread(target=self._run, daemon=True)
            self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=1)
