"""
Default app config for ``sandbox``.

Includes an opt-in startup migration helper controlled by the
``SANDBOX_AUTOMIGRATE`` environment variable. When enabled, the first
time the Django app is initialised (e.g. WSGI worker boot) the app
verifies that the sandbox tables exist and runs ``migrate --noinput`` if
they don't. This avoids the runtime ``relation does not exist`` failure
that caused the error in deployment.
"""
import logging
import os

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class SandboxConfig(AppConfig):
    name = "sandbox"
    label = "sandbox_app"
    verbose_name = "Sandbox Runtime"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        # Opt-in via env var so local/test runs are unaffected.
        if os.environ.get("SANDBOX_AUTOMIGRATE", "").lower() not in (
            "1", "true", "yes", "on",
        ):
            return

        # Skip during management command 'migrate' itself to avoid recursion.
        import sys
        if "migrate" in sys.argv:
            return

        from django.core.management import call_command
        from django.db import connection
        try:
            vendor = connection.vendor
        except Exception:
            vendor = None
        if vendor == "sqlite":
            # Local SQLite — Django creates the file schema on demand;
            # don't run migrate here because core team uses sync migrations.
            return

        try:
            # Cheap probe: tell Django to introspect the sandbox tables.
            with connection.cursor() as cursor:
                tables = connection.introspection.table_names(cursor)
            sandbox_present = any(
                name.startswith("sandbox_app_") for name in tables
            )
            if sandbox_present:
                return

            logger.warning(
                "sandbox tables missing — running migrate --noinput to "
                "auto-create them (SANDBOX_AUTOMIGRATE=1)."
            )
            call_command("migrate", interactive=False, verbosity=1)
        except Exception as exc:
            # Don't crash the WSGI worker even if the DB is unreachable.
            logger.exception("Auto-migrate failed: %s", exc)
