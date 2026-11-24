"""Run the isolated-origin HTTP preview proxy for local Docker workspace sandboxes."""
from django.conf import settings
from django.core.management.base import BaseCommand

from sandbox.services.docker_preview_proxy import run_preview_proxy_server


class Command(BaseCommand):
    help = "Run the isolated-origin HTTP proxy for local Docker workspace port previews."

    def add_arguments(self, parser):
        parser.add_argument("--host", default="0.0.0.0")
        parser.add_argument("--port", type=int, default=getattr(settings, "PREVIEW_PROXY_PORT", 8090))

    def handle(self, *args, **options):
        host = options["host"]
        port = options["port"]
        self.stdout.write(self.style.SUCCESS(f"Starting NeuronRunner preview proxy on http://{host}:{port}"))
        run_preview_proxy_server(host=host, port=port)
