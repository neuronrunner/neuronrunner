import uuid

from django.db import models


class OTP(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField()
    otp = models.CharField(max_length=6)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=['email', 'otp', 'created_at']),
        ]

    def __str__(self):
        return f"OTP for {self.email} - {self.otp}"
