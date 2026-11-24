import base64
import hashlib
import json
import time

from cryptography.fernet import Fernet
from django.conf import settings


def get_fernet():
    # Derive 32-byte key from SECRET_KEY
    digest = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_json(data: dict, expires_in=300) -> str:
    payload = {
        **data,
        "exp": int(time.time()) + expires_in
    }
    f = get_fernet()
    return f.encrypt(json.dumps(payload).encode()).decode()


def decrypt_json(token: str) -> dict:
    f = get_fernet()
    data = json.loads(f.decrypt(token.encode()).decode())

    if data["exp"] < time.time():
        raise ValueError("Token expired")

    return data
