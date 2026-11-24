import hashlib
import os
import random
import secrets
import string
import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models


def profile_picture_upload_path(instance, filename):
    """Generate an upload path for profile pictures based on username."""
    ext = filename.split('.')[-1]
    random_str = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    filename = f"{instance.username}-{random_str}.{ext}"
    return os.path.join('profile_pictures', filename)


class User(AbstractUser):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bio = models.TextField(max_length=500, blank=True)
    profile_picture = models.ImageField(
        upload_to=profile_picture_upload_path,
        blank=True,
        null=True,
    )
    email = models.EmailField(unique=True, blank=True)
    following = models.ManyToManyField(
        'self',
        symmetrical=False,
        related_name='followers',
        blank=True,
    )
    # Personalization
    preferred_name = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="How the user wants to be addressed",
    )
    memory_enabled = models.BooleanField(
        default=True,
        help_text="Whether to create and use memories for this user",
    )
    signup_method = models.CharField(
        max_length=24,
        blank=True,
        default='email',
        help_text="Registration channel: email, google, github",
    )
    signup_source = models.CharField(
        max_length=120,
        blank=True,
        default='',
        help_text="utm_source or referrer host at signup",
    )
    utm_medium = models.CharField(max_length=120, blank=True, default='')
    utm_campaign = models.CharField(max_length=120, blank=True, default='')

    class Meta:
        indexes = [
            models.Index(fields=['-date_joined'], name='user_user_date_joined_idx'),
        ]

    def __str__(self):
        return self.username


def generate_api_key():
    """Generate a random API key with 'nrk_' prefix."""
    return f"nrk_{secrets.token_hex(32)}"


class ApiKey(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='api_keys')
    name = models.CharField(max_length=100)
    key_hash = models.CharField(max_length=128, unique=True, editable=False)
    prefix = models.CharField(max_length=12, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', '-created_at']),
        ]

    def __str__(self):
        return f"{self.name} ({self.prefix}...)"

    @staticmethod
    def hash_key(raw_key: str) -> str:
        return hashlib.sha256(raw_key.encode()).hexdigest()

    @classmethod
    def create_key(cls, user, name: str):
        """Create a new API key. Returns (instance, raw_key)."""
        raw_key = generate_api_key()
        instance = cls(
            user=user,
            name=name,
            key_hash=cls.hash_key(raw_key),
            prefix=raw_key[:12],
        )
        instance.save()
        return instance, raw_key
