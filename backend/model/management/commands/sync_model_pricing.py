from django.core.management.base import BaseCommand
from model.models import Model
from model.services_pricing import openrouter_prices
from sandbox.services.provider_keys import provider_for_model


class Command(BaseCommand):
    help = 'Refresh configured OpenRouter input, output and cache read rates from the public model catalog.'

    def handle(self, *args, **options):
        updated = 0
        for model in Model.objects.filter(is_external=True):
            if provider_for_model(model) != 'openrouter':
                continue
            try:
                rates = openrouter_prices(model.external_model_id)
                for field, value in rates.items():
                    setattr(model, field, value)
                model.save(update_fields=list(rates))
                updated += 1
            except Exception:
                self.stderr.write(f'Pricing unavailable for {model.name}; existing rates retained.')
        self.stdout.write(f'Updated pricing for {updated} model(s).')
