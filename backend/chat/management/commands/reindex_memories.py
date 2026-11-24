"""Rebuild missing, legacy or incompatible embeddings with the configured model."""
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from chat.models import AgentNote, Memory
from chat.services.memory_service import identifier, refresh_embedding, StoreError
from chat.services.utils import embedding_model_name


class Command(BaseCommand):
    help = 'Rebuild memory/note embeddings. Existing records remain available to text search.'

    def add_arguments(self, parser):
        parser.add_argument('--limit', type=int, default=100)
        parser.add_argument('--user', help='Restrict to one user UUID')
        parser.add_argument('--dry-run', action='store_true')
        parser.add_argument('--force', action='store_true', help='Also rebuild current embeddings')

    def handle(self, *args, **options):
        if options['limit'] < 1:
            raise CommandError('--limit must be positive')
        try:
            user_uuid = identifier(options['user'], 'user') if options['user'] else None
        except StoreError as exc:
            raise CommandError(str(exc)) from exc
        remaining = options['limit']
        processed = succeeded = 0
        for model in (Memory, AgentNote):
            qs = model.objects.all()
            if model is Memory:
                qs = qs.filter(user__memory_enabled=True)
            if user_uuid:
                qs = qs.filter(user_id=user_uuid)
            if not options['force']:
                qs = qs.filter(Q(vector__isnull=True) | ~Q(embedding_model=embedding_model_name()))
            for record in qs.order_by('created_at')[:remaining]:
                processed += 1
                remaining -= 1
                if options['dry_run']:
                    continue
                updated = model.objects.filter(pk=record.pk, content=record.content, updated_at=record.updated_at).update(vector=None, embedding_model='')
                if not updated:
                    continue
                refresh_embedding(record)
                succeeded += int(model.objects.filter(pk=record.pk, content=record.content, vector__isnull=False, embedding_model=embedding_model_name()).exists())
            if not remaining:
                break
        if options['dry_run']:
            self.stdout.write(f'{processed} records would be reindexed with {embedding_model_name()}')
        else:
            self.stdout.write(f'{succeeded}/{processed} records reindexed with {embedding_model_name()}')
