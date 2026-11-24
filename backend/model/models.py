from __future__ import annotations

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


def slug_validator(value):
    import re
    if not re.match(r'^[a-zA-Z0-9._-]+$', value):
        raise ValidationError('Name can only contain letters, numbers, hyphens, dots, and underscores.')


def model_thumbnail_upload_path(*args, **kwargs):
    return ""


class Model(models.Model):
    RUNNER_TENSORRT = "tensorrt"
    RUNNER_TENSORRT_LLM = "tensorrtllm"
    RUNNER_VLLM = "vllm"  # legacy alias
    RUNNER_CHOICES = (
        (RUNNER_TENSORRT, "TensorRT"),
        (RUNNER_TENSORRT_LLM, "TensorRT-LLM"),
    )

    SOURCE_HUGGINGFACE = "huggingface"
    SOURCE_VOLUME = "volume"
    SOURCE_EXTERNAL = "external"
    SOURCE_CHOICES = (
        (SOURCE_HUGGINGFACE, "HuggingFace (Volume Cached)"),
        (SOURCE_VOLUME, "Platform Volume"),
        (SOURCE_EXTERNAL, "External Provider (API)"),
    )

    STATUS_PENDING = "pending"
    STATUS_DOWNLOADING = "downloading"
    STATUS_ACTIVE = "active"
    STATUS_ERROR = "error"
    STATUS_DEPRECATED = "deprecated"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_DOWNLOADING, "Downloading"),
        (STATUS_ACTIVE, "Active"),
        (STATUS_ERROR, "Error"),
        (STATUS_DEPRECATED, "Deprecated"),
    )

    TYPES = (
        ('text', 'Text'),
        ('image', 'Image'),
    )

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(validators=[slug_validator], max_length=60, unique=True)
    description = models.CharField(blank=True, max_length=256)
    readme = models.TextField(blank=True, max_length=16384)
    model_type = models.CharField(max_length=50, choices=TYPES, default='text')
    runner = models.CharField(max_length=32, choices=RUNNER_CHOICES, default=RUNNER_TENSORRT)
    source = models.CharField(max_length=32, choices=SOURCE_CHOICES, default=SOURCE_HUGGINGFACE)
    storage_path = models.CharField(max_length=512, blank=True, default="", help_text="HF repo id or volume path")
    file_size_bytes = models.BigIntegerField(default=0, help_text="Total disk size in bytes")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    status_message = models.TextField(blank=True, default="")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='models')
    gpu_requirements = models.JSONField(default=dict, blank=True, help_text="e.g. {'preferred_gpu': 'L40S', 'min_vram_gb': 24, 'fallback_chain': ['L40S', 'RTX6000']}")
    is_reasoning = models.BooleanField(default=False)
    supports_vision = models.BooleanField(default=False, help_text="Whether this model supports image/multimodal visual inputs")
    is_free_tier = models.BooleanField(default=False, help_text="Whether this model is accessible on the Free tier ($1/mo quota)")
    is_external = models.BooleanField(default=False)
    workspace = models.ForeignKey(
        'sandbox_app.Workspace',
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='custom_models',
        help_text='Workspace to which this custom BYOK model belongs (null for global platform models)',
    )
    display_name = models.CharField(
        max_length=120,
        blank=True,
        default="",
        help_text="Human-readable title displayed in Chat dropdown (e.g. 'Claude 3.7 Sonnet')",
    )
    provider_name = models.CharField(
        max_length=32,
        blank=True,
        default="",
        help_text="Provider slug: openrouter, groq, openai, deepseek, google, custom",
    )
    provider_key = models.ForeignKey(
        'sandbox_app.WorkspaceProviderKey',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='custom_models',
        help_text='Configured workspace provider key to use for inference',
    )
    external_url = models.URLField(blank=True, null=True)
    external_model_id = models.CharField(max_length=255, blank=True, null=True)
    external_api_key = models.CharField(max_length=255, blank=True, null=True)
    input_price = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="USD per million input tokens")
    output_price = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="USD per million output tokens")
    cache_read_price = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="USD per million cached input tokens; null uses input price")
    wholesale_input_price = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="Upstream wholesale USD per million input tokens")
    wholesale_output_price = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="Upstream wholesale USD per million output tokens")
    wholesale_cache_read_price = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="Upstream wholesale USD per million cached input tokens")
    downloads = models.PositiveIntegerField(default=0)
    is_public = models.BooleanField(default=True)
    liked_by = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='liked_models', blank=True)
    benchmark_scores = models.JSONField(default=dict, blank=True, help_text="Benchmark scores from llm-stats API")
    llm_stats_id = models.CharField(max_length=100, blank=True, null=True, help_text="Model ID in llm-stats API")
    context_length = models.IntegerField(null=True, blank=True, help_text="Context window length in tokens")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=['author', '-created_at']),
            models.Index(fields=['is_public', 'model_type', '-created_at']),
            models.Index(fields=['is_public', 'model_type', '-downloads']),
            models.Index(fields=['runner', 'status']),
            models.Index(fields=['workspace', '-created_at']),
        ]

    def __str__(self):
        return str(self.name)


class LLMConfig(models.Model):
    """Execution configuration for LLM / vLLM text models."""
    from .reasoning import (
        REASONING_EFFORT_CHOICES as _REASONING_EFFORT_CHOICES,
        REASONING_EFFORT_HIGH as _REASONING_EFFORT_HIGH,
        REASONING_EFFORT_LOW as _REASONING_EFFORT_LOW,
        REASONING_EFFORT_MAX as _REASONING_EFFORT_MAX,
        REASONING_EFFORT_MEDIUM as _REASONING_EFFORT_MEDIUM,
        REASONING_EFFORT_MINIMAL as _REASONING_EFFORT_MINIMAL,
        REASONING_EFFORT_NONE as _REASONING_EFFORT_NONE,
        REASONING_EFFORT_ON as _REASONING_EFFORT_ON,
        REASONING_EFFORT_XHIGH as _REASONING_EFFORT_XHIGH,
        REASONING_MODE_CHOICES as _REASONING_MODE_CHOICES,
        REASONING_MODE_EFFORT as _REASONING_MODE_EFFORT,
        REASONING_MODE_FIXED as _REASONING_MODE_FIXED,
        REASONING_MODE_NONE as _REASONING_MODE_NONE,
        REASONING_MODE_TOGGLE as _REASONING_MODE_TOGGLE,
    )

    REASONING_MODE_NONE = _REASONING_MODE_NONE
    REASONING_MODE_EFFORT = _REASONING_MODE_EFFORT
    REASONING_MODE_TOGGLE = _REASONING_MODE_TOGGLE
    REASONING_MODE_FIXED = _REASONING_MODE_FIXED
    REASONING_MODE_CHOICES = _REASONING_MODE_CHOICES

    REASONING_EFFORT_NONE = _REASONING_EFFORT_NONE
    REASONING_EFFORT_MINIMAL = _REASONING_EFFORT_MINIMAL
    REASONING_EFFORT_LOW = _REASONING_EFFORT_LOW
    REASONING_EFFORT_MEDIUM = _REASONING_EFFORT_MEDIUM
    REASONING_EFFORT_HIGH = _REASONING_EFFORT_HIGH
    REASONING_EFFORT_XHIGH = _REASONING_EFFORT_XHIGH
    REASONING_EFFORT_MAX = _REASONING_EFFORT_MAX
    REASONING_EFFORT_ON = _REASONING_EFFORT_ON
    REASONING_EFFORT_CHOICES = _REASONING_EFFORT_CHOICES

    model = models.OneToOneField(Model, on_delete=models.CASCADE, related_name="llm_config")
    context_length = models.IntegerField(default=4096, help_text="Max context window length in tokens")
    max_tokens = models.IntegerField(default=2048, help_text="Default max completion tokens")
    default_temperature = models.FloatField(default=0.7)
    default_top_p = models.FloatField(default=0.9)
    reasoning_mode = models.CharField(
        max_length=20,
        choices=REASONING_MODE_CHOICES,
        default=REASONING_MODE_NONE,
        help_text="How reasoning is controlled for this model (none, effort, toggle, fixed)",
    )
    supported_reasoning_efforts = models.JSONField(
        default=list,
        blank=True,
        help_text="Ordered list of supported reasoning tiers for this model",
    )
    default_reasoning_effort = models.CharField(
        max_length=20,
        choices=REASONING_EFFORT_CHOICES,
        default=REASONING_EFFORT_MEDIUM,
        help_text="Default reasoning effort for thinking models",
    )
    system_prompt = models.TextField(blank=True, default="")
    chat_template = models.TextField(blank=True, default="", help_text="Custom Jinja2 chat template if any")
    supports_tools = models.BooleanField(default=True, help_text="Supports OpenAI function calling tools")
    quantization = models.CharField(max_length=32, blank=True, default="", help_text="e.g. awq, gptq, fp8")

    # External API settings (used when model.source == 'external')
    external_url = models.URLField(blank=True, null=True, help_text="e.g. https://openrouter.ai/api/v1")
    external_model_id = models.CharField(max_length=255, blank=True, null=True, help_text="e.g. deepseek/deepseek-v4.1-flash-1017")
    external_api_key = models.CharField(max_length=255, blank=True, null=True)

    def __str__(self):
        return f"LLMConfig for {self.model.name}"


class ModelDownloadTask(models.Model):
    """Tracks asynchronous HuggingFace model download and caching jobs."""

    STATUS_QUEUED = "queued"
    STATUS_DOWNLOADING = "downloading"
    STATUS_COMPLETED = "completed"
    STATUS_FAILED = "failed"
    STATUS_CANCELED = "canceled"
    STATUS_CHOICES = (
        (STATUS_QUEUED, "Queued"),
        (STATUS_DOWNLOADING, "Downloading"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_FAILED, "Failed"),
        (STATUS_CANCELED, "Canceled"),
    )

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    model = models.ForeignKey(
        Model,
        on_delete=models.CASCADE,
        related_name="download_tasks",
        null=True,
        blank=True,
    )
    repo_id = models.CharField(max_length=255, help_text="e.g. stabilityai/stable-diffusion-xl-base-1.0")
    initiated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="model_download_tasks_v2",
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_QUEUED, db_index=True)
    external_task_id = models.CharField(max_length=128, blank=True, default="")
    progress_percentage = models.FloatField(default=0.0)
    total_size_bytes = models.BigIntegerField(default=0)
    downloaded_size_bytes = models.BigIntegerField(default=0)
    download_speed_bps = models.FloatField(default=0.0)
    duration_seconds = models.FloatField(null=True, blank=True)
    error_message = models.TextField(blank=True, default="")
    retry_count = models.IntegerField(default=0)
    file_manifest = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["repo_id", "status"]),
            models.Index(fields=["status", "-created_at"]),
        ]

    def __str__(self):
        return f"{self.repo_id} [{self.status}]"


class DiscussionPost(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    model = models.ForeignKey(Model, on_delete=models.CASCADE, related_name='discussion_posts')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='discussion_posts')
    title = models.CharField(max_length=200)
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['model', 'created_at']),
        ]

    def __str__(self):
        return str(self.title)


class DiscussionReply(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    discussion = models.ForeignKey(DiscussionPost, on_delete=models.CASCADE, related_name='replies')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='discussion_replies')
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['discussion', 'created_at']),
        ]

    def __str__(self):
        return str(self.body)[:50]


class SiteSetting(models.Model):
    scaledown_window = models.IntegerField(default=10, help_text="Scaledown window in seconds")
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def get_singleton(cls):
        setting = cls.objects.first()
        if not setting:
            setting = cls.objects.create(scaledown_window=10)
        return setting

    def __str__(self):
        return f"Site Settings (Updated: {self.updated_at.strftime('%Y-%m-%d %H:%M')})"

    class Meta:
        verbose_name = "Site Setting"
        verbose_name_plural = "Site Settings"
