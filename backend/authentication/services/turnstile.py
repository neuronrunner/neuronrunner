"""Cloudflare Turnstile server-side siteverify helper."""
from __future__ import annotations

import logging
import sys

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'


def get_client_ip(request) -> str:
    cf_ip = (request.META.get('HTTP_CF_CONNECTING_IP') or '').strip()
    if cf_ip:
        return cf_ip
    xff = (request.META.get('HTTP_X_FORWARDED_FOR') or '').strip()
    if xff:
        return xff.split(',')[0].strip()
    return (request.META.get('REMOTE_ADDR') or '').strip()


def verify_turnstile_token(request, token: str | None, *, expected_action: str) -> tuple[bool, str | None]:
    """Verify a Cloudflare Turnstile token against siteverify.

    Fails closed whenever TURNSTILE_SECRET is configured (or when DEBUG is False).
    """
    secret = getattr(settings, 'TURNSTILE_SECRET', '') or ''
    if not secret:
        if (
            not getattr(settings, 'TURNSTILE_REQUIRED', False)
            or getattr(settings, 'DEBUG', False)
            or 'test' in sys.argv
        ):
            return True, None
        return False, 'Bot verification is not configured.'

    expected_hostnames = {
        str(h).strip().lower()
        for h in (getattr(settings, 'TURNSTILE_HOSTNAMES', []) or [])
        if str(h).strip()
    }
    if not isinstance(token, str) or not token or len(token) > 2048 or not expected_hostnames:
        return False, 'Bot verification failed. Please refresh and try again.'

    payload = {
        'secret': secret,
        'response': token,
    }
    remote_ip = get_client_ip(request)
    if remote_ip:
        payload['remoteip'] = remote_ip

    try:
        resp = requests.post(SITEVERIFY_URL, data=payload, timeout=10)
        resp.raise_for_status()
        result = resp.json() or {}
    except (requests.RequestException, ValueError) as exc:
        logger.warning('Turnstile siteverify request failed: %s', exc)
        return False, 'Bot verification failed. Please try again.'

    hostname = str(result.get('hostname') or '').strip().lower()
    if (
        result.get('success') is not True
        or result.get('action') != expected_action
        or hostname not in expected_hostnames
    ):
        logger.info(
            'Turnstile rejected: success=%s action=%s expected_action=%s hostname=%s',
            result.get('success'),
            result.get('action'),
            expected_action,
            hostname,
        )
        return False, 'Bot verification failed. Please try again.'

    return True, None
