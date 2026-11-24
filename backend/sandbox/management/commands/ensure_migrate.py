"""
Management command to ensure all database migrations have been applied.

Useful as a release step in deployment pipelines (Railway, Render,
Heroku). Runs `manage.py migrate --noinput` against whichever database
is configured for the runtime.

Usage:
    python manage.py ensure_migrate
"""
from django.core.management import call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Run `migrate --noinput` so all pending schema migrations land."

    def handle(self, *args, **options):
        self.stdout.write("Running migrations…")
        call_command("migrate", interactive=False, verbosity=1, run_syncdb=True)
        self.stdout.write(self.style.SUCCESS("Migrations complete."))
