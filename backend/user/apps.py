from django.apps import AppConfig


class UserConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'user'

    def ready(self):
        # Ensure signal handlers are registered on app startup.
        from . import signals  # noqa: F401
