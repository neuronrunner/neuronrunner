import asyncio
import logging
import time

from asgiref.sync import iscoroutinefunction, markcoroutinefunction
from django.db import close_old_connections
from django.db.utils import OperationalError

logger = logging.getLogger(__name__)

WARMUP_ERROR_SNIPPETS = (
    "the database system is starting up",
    "could not connect to server",
    "connection to server at",
    "server closed the connection unexpectedly",
    "ssl connection has been closed unexpectedly",
    "connection refused",
)


def is_warmup_error(exc: Exception) -> bool:
    """Return True if the operational error indicates a database warm-up / cold-start phase."""
    msg = str(exc).lower()
    return any(snippet in msg for snippet in WARMUP_ERROR_SNIPPETS)


class DatabaseWarmupMiddleware:
    """
    Catches transient database warm-up / cold-start errors when PostgreSQL
    is scaling up from scale-to-zero, retrying the request after a short backoff.
    """
    sync_capable = True
    async_capable = True

    def __init__(self, get_response):
        self.get_response = get_response
        if iscoroutinefunction(self.get_response):
            markcoroutinefunction(self)

    def __call__(self, request):
        if iscoroutinefunction(self.get_response):
            return self.__acall__(request)

        max_attempts = 4
        delays = [1.0, 2.0, 2.0]
        for attempt in range(max_attempts):
            try:
                return self.get_response(request)
            except OperationalError as exc:
                if attempt < len(delays) and is_warmup_error(exc):
                    logger.warning(
                        "Database is warming up (attempt %d/%d). Retrying in %.1fs: %s",
                        attempt + 1, max_attempts, delays[attempt], exc,
                    )
                    close_old_connections()
                    time.sleep(delays[attempt])
                else:
                    raise

    async def __acall__(self, request):
        max_attempts = 4
        delays = [1.0, 2.0, 2.0]
        for attempt in range(max_attempts):
            try:
                return await self.get_response(request)
            except OperationalError as exc:
                if attempt < len(delays) and is_warmup_error(exc):
                    logger.warning(
                        "Database is warming up (attempt %d/%d). Retrying in %.1fs: %s",
                        attempt + 1, max_attempts, delays[attempt], exc,
                    )
                    close_old_connections()
                    await asyncio.sleep(delays[attempt])
                else:
                    raise
