"""Import public OpenRouter rates; stored values are USD per million tokens.

Prices match the OpenCode floor table or live OpenRouter wholesale * retail markup
(default 1.30x = +30%), whichever is higher, ensuring a positive gross margin.
"""
from decimal import Decimal, ROUND_CEILING
import requests
from django.core.cache import cache

# Minimum retail prices in USD per 1M tokens: (input_price, output_price, cache_read_price)
OPENCODE_PRICE_FLOORS: dict[str, tuple[Decimal, Decimal, Decimal | None]] = {
    # Free tier models
    'z-ai/glm-5.3-flash': (Decimal('0.15'), Decimal('0.50'), Decimal('0.04')),
    'deepseek/deepseek-v4.1-flash-1017': (Decimal('0.25'), Decimal('0.75'), Decimal('0.01')),
    'xiaomi/mimo-v2.6-flash': (Decimal('0.19'), Decimal('0.37'), Decimal('0.01')),
    'qwen/qwen3.8-flash': (Decimal('0.20'), Decimal('0.62'), Decimal('0.03')),
    'openai/gpt-6-luna': (Decimal('0.13'), Decimal('0.65'), Decimal('0.02')),
    'anthropic/claude-haiku-5.5': (Decimal('0.13'), Decimal('0.65'), Decimal('0.02')),
    # Premium subscription models
    'deepseek/deepseek-v4-pro-0813': (Decimal('0.70'), Decimal('5.80'), Decimal('0.13')),
    'z-ai/glm-5.3': (Decimal('1.40'), Decimal('4.70'), Decimal('0.26')),
    'google/gemini-4-hydrogen': (Decimal('2.00'), Decimal('9.80'), Decimal('0.10')),
    'openai/gpt-6.1-sol': (Decimal('2.60'), Decimal('13.00'), Decimal('0.13')),
    'openai/gpt-6.1-terra': (Decimal('1.30'), Decimal('6.50'), Decimal('0.07')),
    'anthropic/claude-sonnet-5.5': (Decimal('2.60'), Decimal('13.00'), Decimal('0.13')),
    'x-ai/grok-4.7': (Decimal('2.60'), Decimal('7.80'), Decimal('0.65')),
    'qwen/qwen3.8-max-0902': (Decimal('2.60'), Decimal('7.80'), Decimal('0.33')),
    'moonshotai/kimi-k3.1-pro': (Decimal('2.00'), Decimal('11.00'), Decimal('0.26')),
}


def round_retail_price(value: Decimal) -> Decimal:
    """Round retail USD/1M token rate upward to clean increments ($0.10 >= $1, else $0.01)."""
    if value <= 0:
        return Decimal('0.00')
    step = Decimal('0.10') if value >= Decimal('1.00') else Decimal('0.01')
    steps = (value / step).to_integral_value(rounding=ROUND_CEILING)
    return (steps * step).quantize(Decimal('0.01'))


def retail_markup_multiplier() -> Decimal:
    from django.conf import settings
    try:
        val = Decimal(str(getattr(settings, 'LLM_RETAIL_MARKUP', '1.30') or '1.30'))
        if val.is_finite() and val >= Decimal('1.00'):
            return val
    except Exception:
        pass
    return Decimal('1.30')


def openrouter_prices(model_id):
    catalog = cache.get('openrouter-price-catalog-v1')
    if catalog is None:
        response = requests.get('https://openrouter.ai/api/v1/models', timeout=10, allow_redirects=False)
        response.raise_for_status()
        catalog = {item['id']: item.get('pricing', {}) for item in response.json().get('data', []) if item.get('id')}
        cache.set('openrouter-price-catalog-v1', catalog, 3600)
    pricing = catalog.get(model_id)
    floor = OPENCODE_PRICE_FLOORS.get(model_id)
    if not pricing and not floor:
        raise ValueError('Model token pricing is unavailable.')
    pricing = pricing or {}
    markup = retail_markup_multiplier()
    result = {}
    field_map = [
        ('input_price', 'prompt', 0),
        ('output_price', 'completion', 1),
        ('cache_read_price', 'input_cache_read', 2),
    ]
    for field, upstream, floor_idx in field_map:
        raw = pricing.get(upstream)
        floor_val = floor[floor_idx] if floor else None
        if raw is None:
            if floor_val is not None:
                result[field] = floor_val
                continue
            if field == 'cache_read_price':
                result[field] = None
                continue
            raise ValueError('Model token pricing is incomplete.')
        value = Decimal(str(raw)) * Decimal(1_000_000)
        if not value.is_finite() or value < 0:
            raise ValueError('Model token pricing is invalid.')
        value = round_retail_price(value * markup)
        if floor_val is not None and value < floor_val:
            value = floor_val
        result[field] = value
    return result


def openrouter_wholesale_prices(model_id):
    """Return raw upstream OpenRouter rates (USD per 1M tokens) without retail floor adjustment."""
    catalog = cache.get('openrouter-price-catalog-v1')
    if catalog is None:
        response = requests.get('https://openrouter.ai/api/v1/models', timeout=10, allow_redirects=False)
        response.raise_for_status()
        catalog = {item['id']: item.get('pricing', {}) for item in response.json().get('data', []) if item.get('id')}
        cache.set('openrouter-price-catalog-v1', catalog, 3600)
    pricing = catalog.get(model_id) or {}
    result = {}
    for field, upstream in (
        ('wholesale_input_price', 'prompt'),
        ('wholesale_output_price', 'completion'),
        ('wholesale_cache_read_price', 'input_cache_read'),
    ):
        raw = pricing.get(upstream)
        if raw is None:
            continue
        try:
            value = Decimal(str(raw)) * Decimal(1_000_000)
            if value.is_finite() and value >= 0:
                result[field] = value
        except Exception:
            continue
    return result


def ensure_model_pricing(model):
    if model.input_price is not None and model.output_price is not None:
        return
    from sandbox.services.provider_keys import provider_for_model
    if provider_for_model(model) != 'openrouter':
        raise ValueError('Token pricing is not configured for this model.')
    try:
        rates = openrouter_prices(model.external_model_id)
        wholesale = openrouter_wholesale_prices(model.external_model_id)
    except Exception:
        raise ValueError('Model pricing could not be loaded. Configure token rates or add a workspace provider key.') from None
    update_fields = list(rates)
    for field, value in rates.items():
        setattr(model, field, value)
    for field, value in wholesale.items():
        if getattr(model, field, None) is None:
            setattr(model, field, value)
            update_fields.append(field)
    model.save(update_fields=update_fields)
