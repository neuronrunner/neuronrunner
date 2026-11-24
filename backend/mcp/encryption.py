import base64
import json
import logging

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings

logger = logging.getLogger(__name__)


def _get_fernet_key() -> bytes:
    salt = b'neuronrunner-mcp-env'
    info = b'env-encryption-v1'
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        info=info,
    )
    key = hkdf.derive(settings.SECRET_KEY.encode())
    return base64.urlsafe_b64encode(key)


_cipher = None
_cipher_secret = None


def _get_cipher() -> Fernet:
    global _cipher, _cipher_secret
    secret = settings.SECRET_KEY
    if _cipher is None or _cipher_secret != secret:
        _cipher = Fernet(_get_fernet_key())
        _cipher_secret = secret
    return _cipher


def encrypt_env_json(env_json: dict) -> str:
    if not env_json:
        return ""
    try:
        data = json.dumps(env_json, separators=(',', ':')).encode()
        return _get_cipher().encrypt(data).decode()
    except Exception as e:
        logger.exception("Failed to encrypt env_json")
        raise ValueError(f"Encryption failed: {e or type(e).__name__}")


def decrypt_env_json(encrypted: str) -> dict:
    if not encrypted:
        return {}
    try:
        data = _get_cipher().decrypt(encrypted.encode())
        return json.loads(data)
    except Exception as e:
        logger.exception("Failed to decrypt env_json")
        raise ValueError(f"Decryption failed: {e or type(e).__name__}")
