import uuid

from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models
from pgvector.django import VectorField


class Conversation(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    workspace = models.ForeignKey("sandbox_app.Workspace", on_delete=models.SET_NULL, null=True, blank=True, related_name="conversations")
    title = models.CharField(max_length=255, blank=True, null=True, help_text="Optional title for the conversation")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, help_text="User who owns the conversation")
    runtime_name = models.CharField(
        max_length=24, blank=True, default="",
        help_text="Named local Docker runtime the conversation's tools run in; empty means the workspace default",
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', '-created_at']),
        ]

    def __str__(self):
        return f"Conversation {self.pk} - {self.title or 'Untitled'}"

class Message(models.Model):
    MESSAGE_TYPE_CHOICES = [
        ('text', 'Text'),
        ('image', 'Image'),
    ]
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='messages')
    parent = models.ForeignKey('self', on_delete=models.CASCADE, null=True, blank=True, related_name='children')
    content = models.TextField()
    search_vector = SearchVectorField(null=True, blank=True, help_text="Full-text search vector for session search")
    thinking = models.TextField(null=True, blank=True, help_text="Reasoning/thinking content associated with assistant response")
    thinking_summary = models.TextField(null=True, blank=True, help_text="LLM-generated short summary of the thinking content")
    thinking_segments = models.JSONField(null=True, blank=True, help_text="Thinking content split per round")
    phases = models.JSONField(null=True, blank=True, help_text="Ordered timeline phases for the ThinkingBlock UI")
    role = models.CharField(max_length=20)
    type = models.CharField(max_length=10, choices=MESSAGE_TYPE_CHOICES, default='text', help_text="Type of message: text or image")
    tool_calls = models.JSONField(null=True, blank=True, help_text="Tool calls made by the assistant during generation")
    file_diff = models.JSONField(null=True, blank=True, help_text="Git diff of file changes made during this turn")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=['conversation', 'created_at']),
            GinIndex(fields=['search_vector']),
        ]


class MessageAttachment(models.Model):
    """File attachments uploaded with a user message."""
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='attachments')
    file = models.FileField(upload_to='chat_attachments/')
    original_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=128, blank=True, null=True)
    file_size = models.BigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['message', 'created_at']),
        ]

    def __str__(self):
        return f"Attachment {self.original_name} ({self.message.uuid})"

class Request(models.Model):
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('canceled', 'Canceled'),
        ('failed', 'Failed'),
    ]
    PRICING_CHOICES = [
        ('token', 'Per Million Tokens'),
        ('duration', 'Per Hour of GPU Time'),
    ]
    REASONING_CHOICES = [
        ('none', 'None (Off)'),
        ('minimal', 'Minimal'),
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
        ('xhigh', 'XHigh'),
        ('max', 'Max'),
        ('on', 'On'),
    ]
    uuid = models.UUIDField(default=uuid.uuid4, primary_key=True, editable=False, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    model = models.ForeignKey('model.Model', on_delete=models.SET_NULL, null=True, help_text="Model used for this request")
    error_message = models.TextField(null=True, blank=True, help_text="Error message if the request failed")
    partial_content = models.TextField(null=True, blank=True, help_text="Partial streamed assistant content")
    partial_thinking = models.TextField(null=True, blank=True, help_text="Partial streamed assistant reasoning")
    partial_phases = models.JSONField(null=True, blank=True)
    partial_tool_calls = models.JSONField(null=True, blank=True)

    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='pending', help_text="Current status of the request")
    started_at = models.DateTimeField(null=True, blank=True)
    last_activity_at = models.DateTimeField(null=True, blank=True, help_text="Last generation worker heartbeat")
    completed_at = models.DateTimeField(null=True, blank=True)
    parent = models.ForeignKey(Message, on_delete=models.SET_NULL, null=True, related_name='requests')
    conversation = models.ForeignKey(Conversation, on_delete=models.SET_NULL, related_name="requests", null=True, help_text="Associated conversation")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, help_text="User who made the request")
    reasoning_level = models.CharField(max_length=16, null=True, blank=True, choices=REASONING_CHOICES, help_text="Reasoning level for the request")

    workspace = models.ForeignKey("sandbox_app.Workspace", on_delete=models.PROTECT, null=True, blank=True, related_name="usage_requests")
    uses_byok = models.BooleanField(default=False)
    provider = models.CharField(max_length=32, blank=True, default="")
    charged_cost = models.DecimalField(max_digits=16, decimal_places=8, default=0)
    cached_input_tokens = models.PositiveIntegerField(default=0)
    cache_read_price_snapshot = models.DecimalField(max_digits=16, decimal_places=12, null=True, blank=True)

    # Tokens
    input_tokens = models.IntegerField(null=True, blank=True, help_text="Number of input tokens")
    output_tokens = models.IntegerField(null=True, blank=True, help_text="Number of output tokens")

    # LLM Settings (only for text models)
    temperature = models.FloatField(null=True, blank=True, help_text="Temperature for sampling")
    top_p = models.FloatField(null=True, blank=True, help_text="Top P for nucleus sampling")
    system_prompt = models.TextField(blank=True, null=True, help_text="System prompt to guide the model's behavior")

    # Pricing info
    cost = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="Total cost for this request")
    provider_cost = models.DecimalField(max_digits=16, decimal_places=8, null=True, blank=True, help_text="Actual upstream provider cost in USD")
    provider_cost_source = models.CharField(max_length=24, blank=True, default="", help_text="How provider_cost was captured: upstream_usage, wholesale_rate, byok")
    duration_seconds = models.FloatField(null=True, blank=True, help_text="Duration of the request in seconds")

    # Snapshot of pricing at the time of request
    pricing_model_snapshot = models.CharField(max_length=20, default='duration', choices=PRICING_CHOICES, help_text="Pricing model used for this request")
    input_price_snapshot = models.DecimalField(max_digits=16, decimal_places=12, null=True, blank=True, help_text="Price per input token")
    output_price_snapshot = models.DecimalField(max_digits=16, decimal_places=12, null=True, blank=True, help_text="Price per output tokens")
    price_per_hour_snapshot = models.DecimalField(max_digits=16, decimal_places=12, null=True, blank=True, help_text="Price per hour for GPU usage")

    class Meta:
        indexes = [
            models.Index(fields=['user', '-created_at'], name='idx_request_user_created'),
            models.Index(fields=['conversation', 'status', 'created_at']),
            models.Index(fields=['-created_at'], name='idx_request_created'),
        ]
        ordering = ['-created_at']

    def __str__(self):
        return f"Request {self.pk} - {self.status}"

class Image(models.Model):
    """Model for storing image and video generation parameters and assets."""
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True, primary_key=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='generated_images')
    message = models.ForeignKey(Message, on_delete=models.CASCADE, null=True, blank=True, related_name='images', help_text="Message associated with the generated image if from chat")
    model = models.ForeignKey('model.Model', on_delete=models.SET_NULL, null=True, blank=True, related_name='generated_images', help_text="Model used to generate this image")
    image = models.ImageField(upload_to='generated_images/', null=True, blank=True, help_text="Path to the generated image")
    video_file = models.FileField(upload_to='generated_videos/', null=True, blank=True, help_text="Path to the generated video")
    asset_type = models.CharField(max_length=20, default='image', choices=[('image', 'Image'), ('video', 'Video')])
    prompt = models.TextField(help_text="Prompt used to generate the image")
    negative_prompt = models.TextField(blank=True, null=True, help_text="Negative prompt used")
    width = models.IntegerField(default=512, help_text="Image width in pixels")
    height = models.IntegerField(default=512, help_text="Image height in pixels")
    seed = models.IntegerField(null=True, blank=True, help_text="Random seed used for generation")
    num_inference_steps = models.IntegerField(default=50, help_text="Number of inference steps")
    guidance_scale = models.FloatField(default=7.5, help_text="Guidance scale used")
    duration_seconds = models.FloatField(default=0.0, help_text="GPU execution duration in seconds")
    cost_usd = models.DecimalField(max_digits=12, decimal_places=6, default=0.0, help_text="Total cost in USD calculated from GPU price")
    shared = models.BooleanField(default=False, help_text="Indicates whether the user shared this image publicly")
    shared_at = models.DateTimeField(null=True, blank=True, help_text="When the image was shared")
    nsfw = models.CharField(max_length=10, default='unknown', choices=[
        ('nsfw', 'NSFW'),
        ('normal', 'Normal'),
        ('unknown', 'Unknown'),
        ('processing', 'Processing')
    ], help_text="NSFW classification result")
    related_categories = models.ManyToManyField('ImageCategory', blank=True, related_name='images')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['shared', '-shared_at', '-created_at']),
            models.Index(fields=['shared', 'nsfw', '-shared_at']),
            models.Index(fields=['message', '-created_at']),
            models.Index(fields=['user', '-created_at']),
        ]

    def __str__(self):
        return f"Image/Asset {self.uuid}"


class ImageCategory(models.Model):
    """Keyword tag assigned to shared images."""
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True, primary_key=True)
    name = models.CharField(max_length=50, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name

class ImageReaction(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    image = models.ForeignKey(Image, on_delete=models.CASCADE, related_name='reactions')
    emoji = models.CharField(max_length=10)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('user', 'image', 'emoji')


class ImageComment(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='image_comments')
    image = models.ForeignKey(Image, on_delete=models.CASCADE, related_name='comments')
    content = models.TextField(max_length=1000, help_text="Comment content")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['image', '-created_at']),
        ]

    def __str__(self):
        return f"Comment by {self.user.username} on {self.image.uuid}"


MEMORY_CATEGORIES = [
    ('identity', 'Identity'),
    ('preference', 'Preference'),
    ('workspace', 'Workspace'),
    ('knowledge', 'Knowledge'),
    ('relationship', 'Relationship'),
]


class Memory(models.Model):
    """User profile store (Hermes 'user' equivalent).
    
    Facts about the user extracted from conversations — identity, preferences,
    workspaces, knowledge, relationships. Auto-extracted by LLM, also CRUD via tool.
    """
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='memories')
    content = models.TextField(help_text="Content of the memory")
    vector = VectorField(null=True, blank=True, help_text="Optional vector embedding for similarity search")
    embedding_model = models.CharField(max_length=255, blank=True, default='')
    source_message = models.ForeignKey('Message', on_delete=models.SET_NULL, null=True, blank=True, related_name='extracted_memories')
    category = models.CharField(max_length=20, choices=MEMORY_CATEGORIES, null=True, blank=True, help_text="Memory category")
    importance_score = models.IntegerField(default=5, help_text="Importance score from 1 (low) to 10 (high)")
    label = models.CharField(max_length=100, null=True, blank=True, help_text="Short label/tag for quick filtering (e.g. 'name', 'framework')")
    last_accessed_at = models.DateTimeField(null=True, blank=True, help_text="Last time this memory was retrieved")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('user', 'content')
        indexes = [
            models.Index(fields=['user', '-created_at']),
        ]

    def __str__(self):
        category_str = f" [{self.get_category_display()}]" if self.category else ""
        return f"Memory{category_str} {self.content[:50]} for User {self.user_id}"


class AgentNote(models.Model):
    """General agent notes store (Hermes 'memory' equivalent).
    
    Environment facts, project context, tool quirks, conventions — written
    actively by the model via tool calls during conversation, not auto-extracted.
    Workspace/project notes are shared with members; legacy unscoped notes are personal.
    """
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='agent_notes')
    workspace = models.ForeignKey('sandbox_app.Workspace', on_delete=models.CASCADE, null=True, blank=True, related_name='agent_notes')
    sandbox = models.ForeignKey(
        'sandbox_app.Sandbox',
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='agent_notes',
        help_text="Optional project sandbox association for scoped notes."
    )
    content = models.TextField(help_text="Content of the note")
    vector = VectorField(null=True, blank=True, help_text="Optional vector embedding for similarity search")
    embedding_model = models.CharField(max_length=255, blank=True, default='')
    source_message = models.ForeignKey('Message', on_delete=models.SET_NULL, null=True, blank=True, related_name='agent_notes')
    category = models.CharField(max_length=30, null=True, blank=True,
        help_text="Optional category (e.g. 'project', 'tool', 'env', 'preference')")
    importance_score = models.IntegerField(default=3, help_text="Importance from 1 (low) to 10 (high)")
    last_accessed_at = models.DateTimeField(null=True, blank=True, help_text="Last time this note was retrieved")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['user', '-created_at']),
        ]

    def __str__(self):
        return f"AgentNote {self.content[:50]} for User {self.user_id}"


class Tool(models.Model):
    """Built-in tool definition stored in DB instead of hardcoded lists."""

    CATEGORY_CHOICES = [
        ('memory', 'Memory & Notes'),
        ('search', 'Search'),
        ('utility', 'Utility'),
        ('web', 'Web & Network'),
        ('code', 'Code & Files'),
    ]

    name = models.CharField(max_length=100, unique=True,
        help_text="Tool name used in function calling (e.g. 'web_search')")
    description = models.TextField(help_text="Description for the OpenAI function schema")
    parameters_schema = models.JSONField(default=dict, blank=True,
        help_text="The 'parameters' block of the OpenAI function schema (type, properties, required)")
    handler_path = models.CharField(max_length=255, blank=True,
        help_text="Dotted path to handler function, e.g. 'chat.tools.web_search.handle'")
    category = models.CharField(max_length=30, choices=CATEGORY_CHOICES, default='utility')
    is_builtin = models.BooleanField(default=True,
        help_text="True for built-in tools, False for MCP/custom")
    enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def to_function_schema(self) -> dict:
        """Produce an OpenAI-compatible function definition."""
        from chat.store_schemas import normalize_store_schema
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": normalize_store_schema(self.name, self.parameters_schema),
            }
        }

    def __str__(self):
        return self.name
