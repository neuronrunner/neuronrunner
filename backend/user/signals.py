import logging

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models.signals import post_save, pre_delete
from django.dispatch import receiver

logger = logging.getLogger(__name__)


@receiver(pre_delete, sender=get_user_model())
def cleanup_legacy_authtoken_rows(sender, instance, **kwargs):
    """Remove rows from legacy DRF authtoken table before deleting a user."""
    with connection.cursor() as cursor:
        table_names = connection.introspection.table_names(cursor)
        if 'authtoken_token' not in table_names:
            return
        cursor.execute(
            'DELETE FROM authtoken_token WHERE user_id = %s',
            [str(instance.pk)],
        )


@receiver(post_save, sender=get_user_model())
def create_personal_workspace_for_user(sender, instance, created, **kwargs):
    """Create a personal workspace on signup without adding a project."""
    if not created or kwargs.get('raw', False):
        return
    try:
        from sandbox.services.sandbox_service import SandboxBootstrapService
        SandboxBootstrapService.ensure_personal_workspace(instance)
    except Exception as exc:
        logger.warning("Could not create personal workspace for user %s: %s", instance, exc)
