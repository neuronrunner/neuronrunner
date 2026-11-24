from decimal import Decimal, ROUND_HALF_UP
import os

import requests
from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q

from chat.models import Request as ChatRequest
from model.models import Model


OR_MODELS_URL = 'https://openrouter.ai/api/v1/models'
QUANT = Decimal('0.00000001')

# Historical deleted-model snapshots mapped to their OpenRouter external_model_id.
SNAPSHOT_MODEL_FALLBACKS = {
    (Decimal('0.045000000000'), Decimal('0.500000000000')): 'deepseek/deepseek-v4.1-flash-1017',
}


def _wholesale_from_or_pricing(pricing_dict: dict) -> dict:
    """Convert OpenRouter per-token pricing strings into USD per 1M tokens."""
    prices = {}
    if not isinstance(pricing_dict, dict):
        return prices
    for target, source_key in (
        ('wholesale_input_price', 'prompt'),
        ('wholesale_output_price', 'completion'),
        ('wholesale_cache_read_price', 'input_cache_read'),
    ):
        raw = pricing_dict.get(source_key)
        if raw is None:
            continue
        try:
            val = Decimal(str(raw)) * Decimal(1_000_000)
            if val.is_finite() and val >= 0:
                prices[target] = val.quantize(QUANT, rounding=ROUND_HALF_UP)
        except Exception:
            continue
    return prices


def _calculate_wholesale_cost(req: ChatRequest, prices: dict) -> Decimal:
    """Compute wholesale USD cost for a request matching ChatService._calculate_cost."""
    w_in = prices['wholesale_input_price']
    w_out = prices['wholesale_output_price']
    w_cache = prices.get('wholesale_cache_read_price')
    if w_cache is None:
        w_cache = w_in
    inp = max(0, int(req.input_tokens or 0))
    cached = min(inp, max(0, int(req.cached_input_tokens or 0)))
    out = max(0, int(req.output_tokens or 0))
    total = (
        Decimal(inp - cached) * w_in
        + Decimal(cached) * w_cache
        + Decimal(out) * w_out
    ) / Decimal(1_000_000)
    return max(Decimal('0'), total).quantize(QUANT, rounding=ROUND_HALF_UP)


class Command(BaseCommand):
    help = 'Fetch live wholesale prices from OpenRouter and backfill missing Model wholesale rates and Request provider_cost.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Preview updates without writing to the database.',
        )
        parser.add_argument(
            '--overwrite-models',
            action='store_true',
            help='Overwrite existing wholesale prices on Model records.',
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        overwrite_models = options['overwrite_models']

        api_key = getattr(settings, 'OPENROUTER_API_KEY', '') or os.getenv('OPENROUTER_API_KEY', '')
        headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}

        res = requests.get(OR_MODELS_URL, headers=headers, timeout=20)
        res.raise_for_status()
        or_prices = {}
        for item in res.json().get('data', []):
            mid = item.get('id')
            if not mid:
                continue
            parsed = _wholesale_from_or_pricing(item.get('pricing'))
            if 'wholesale_input_price' in parsed and 'wholesale_output_price' in parsed:
                or_prices[mid] = parsed

        self.stdout.write(f'Fetched wholesale pricing for {len(or_prices)} models from OpenRouter.')

        models_updated = 0
        reqs_updated = 0
        reqs_skipped = 0
        total_provider_cost = Decimal('0')

        with transaction.atomic():
            or_db_models = Model.objects.filter(provider_name='openrouter').exclude(external_model_id='')
            for model_obj in or_db_models:
                prices = or_prices.get(model_obj.external_model_id)
                if not prices:
                    continue
                update_fields = []
                for field in ('wholesale_input_price', 'wholesale_output_price', 'wholesale_cache_read_price'):
                    new_val = prices.get(field)
                    if new_val is None:
                        continue
                    cur_val = getattr(model_obj, field)
                    if overwrite_models or cur_val is None:
                        if cur_val != new_val:
                            setattr(model_obj, field, new_val)
                            update_fields.append(field)
                if update_fields:
                    models_updated += 1
                    if not dry_run:
                        model_obj.save(update_fields=update_fields)

            untracked_reqs = (
                ChatRequest.objects.select_related('model')
                .filter(uses_byok=False, provider_cost__isnull=True)
                .filter(Q(provider='openrouter') | Q(model__provider_name='openrouter'))
            )

            batch = []
            for req in untracked_reqs.iterator(chunk_size=500):
                ext_id = None
                if req.model is not None and req.model.external_model_id:
                    ext_id = req.model.external_model_id
                elif req.input_price_snapshot is not None and req.output_price_snapshot is not None:
                    ext_id = SNAPSHOT_MODEL_FALLBACKS.get(
                        (req.input_price_snapshot, req.output_price_snapshot)
                    )

                prices = or_prices.get(ext_id) if ext_id else None
                if not prices and req.model is not None:
                    if req.model.wholesale_input_price is not None and req.model.wholesale_output_price is not None:
                        prices = {
                            'wholesale_input_price': req.model.wholesale_input_price,
                            'wholesale_output_price': req.model.wholesale_output_price,
                            'wholesale_cache_read_price': req.model.wholesale_cache_read_price,
                        }

                if not prices:
                    reqs_skipped += 1
                    continue

                cost_val = _calculate_wholesale_cost(req, prices)
                total_provider_cost += cost_val
                reqs_updated += 1
                if not dry_run:
                    req.provider_cost = cost_val
                    req.provider_cost_source = 'wholesale_rate'
                    batch.append(req)
                    if len(batch) >= 500:
                        ChatRequest.objects.bulk_update(batch, ['provider_cost', 'provider_cost_source'])
                        batch.clear()

            if not dry_run and batch:
                ChatRequest.objects.bulk_update(batch, ['provider_cost', 'provider_cost_source'])

            if dry_run:
                transaction.set_rollback(True)

        prefix = '[DRY RUN] ' if dry_run else ''
        self.stdout.write(
            self.style.SUCCESS(
                f'{prefix}Updated {models_updated} Model(s), backfilled {reqs_updated} Request(s) '
                f'(total wholesale cost: ${total_provider_cost:.8f}), skipped {reqs_skipped}.'
            )
        )
