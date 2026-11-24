import logging
import time

from django.core.management.base import BaseCommand

from sandbox.services.sandbox_session import get_sandbox_manager


class Command(BaseCommand):
    help = "Run the persistent loop to clean up idle sandboxes every 5 seconds."

    def handle(self, *args, **options):
        logging.basicConfig(level=logging.INFO)
        logging.getLogger(__name__)

        manager = get_sandbox_manager()
        self.stdout.write("Starting sandbox cleanup loop (5s interval)...")

        while True:
            try:
                manager.cleanup_all_idle()
            except Exception as e:
                self.stderr.write(f"Error in sandbox cleanup loop: {e}")
            time.sleep(5)
