"""Email hygiene checks to block disposable domains and alias farming on signup."""
from __future__ import annotations

from django.contrib.auth import get_user_model

User = get_user_model()

GMAIL_DOMAINS = frozenset({'gmail.com', 'googlemail.com'})

DISPOSABLE_EMAIL_DOMAINS = frozenset({
    '10minutemail.com',
    '10minutemail.net',
    'burnermail.io',
    'dispostable.com',
    'dropmail.me',
    'emailondeck.com',
    'fakeinbox.com',
    'getairmail.com',
    'getnada.com',
    'guerrillamail.biz',
    'guerrillamail.com',
    'guerrillamail.de',
    'guerrillamail.info',
    'guerrillamail.net',
    'guerrillamail.org',
    'harakirimail.com',
    'inboxkitten.com',
    'mailcatch.com',
    'maildrop.cc',
    'mailinator.com',
    'mailinator.net',
    'mailnesia.com',
    'mintemail.com',
    'mohmal.com',
    'mytemp.email',
    'sharklasers.com',
    'spam4.me',
    'temp-mail.io',
    'temp-mail.org',
    'tempmail.com',
    'tempmail.dev',
    'tempmail.net',
    'tempr.email',
    'throwawaymail.com',
    'trashmail.com',
    'trashmail.net',
    'yopmail.com',
    'yopmail.fr',
    'yopmail.net',
})


def canonicalize_email(email: str) -> str:
    """Return canonical lowercase email, normalizing Gmail dots and +tags."""
    normalized = str(email or '').strip().lower()
    if '@' not in normalized:
        return normalized
    local, domain = normalized.rsplit('@', 1)
    if domain in GMAIL_DOMAINS:
        local = local.split('+', 1)[0].replace('.', '')
        domain = 'gmail.com'
    return f'{local}@{domain}'


def validate_registration_email(email: str) -> str | None:
    """Return an error message if email is disposable, uses +alias, or matches an existing account."""
    normalized = str(email or '').strip().lower()
    if '@' not in normalized:
        return 'Invalid email'
    local, domain = normalized.rsplit('@', 1)

    if domain in DISPOSABLE_EMAIL_DOMAINS:
        return 'Disposable or temporary email addresses are not allowed.'

    if '+' in local:
        return "Email aliases with '+' are not allowed for registration."

    if User.objects.filter(email__iexact=normalized).exists():
        return 'Email already registered'

    if domain in GMAIL_DOMAINS:
        target_canonical = canonicalize_email(normalized)
        existing_gmails = User.objects.filter(
            email__iregex=r'@(gmail|googlemail)\.com$'
        ).values_list('email', flat=True)
        for existing in existing_gmails:
            if canonicalize_email(existing) == target_canonical:
                return 'Email already registered'

    return None
