import uuid

from django.conf import settings
from django.db import models

TRANSPORT_CHOICES = [
    ('stdio', 'stdio (subprocess)'),
    ('http', 'HTTP / SSE'),
]


class MCPServer(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='mcp_servers')
    workspace = models.ForeignKey(
        'sandbox_app.Workspace', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='mcp_servers', help_text='Workspace sandbox used for local MCP commands',
    )
    name = models.CharField(max_length=100)
    transport = models.CharField(max_length=10, choices=TRANSPORT_CHOICES, default='stdio')

    command = models.CharField(max_length=500, blank=True, null=True,
                               help_text="Command for stdio transport, e.g. 'npx -y @anthropic-ai/mcp-server-github'")
    url = models.URLField(max_length=500, blank=True, null=True,
                          help_text="URL for HTTP transport")
    http_transport = models.CharField(max_length=20, default='sse',
                                     choices=[('sse', 'SSE'), ('streamable-http', 'Streamable HTTP')])
    _headers_json_encrypted = models.TextField(default='', blank=True)
    auth_type = models.CharField(max_length=10, default='manual', choices=[('manual', 'API token / none'), ('oauth', 'OAuth')])
    _oauth_json_encrypted = models.TextField(default='', blank=True)

    _env_json_encrypted = models.TextField(default="", blank=True,
                                           help_text="Encrypted environment variables")
    enabled = models.BooleanField(default=True)
    timeout = models.PositiveIntegerField(default=15,
                                          help_text="Timeout in seconds for MCP operations")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"MCP Server {self.name} ({self.transport})"

    @property
    def headers_json(self) -> dict:
        from .encryption import decrypt_env_json
        return decrypt_env_json(self._headers_json_encrypted)

    @headers_json.setter
    def headers_json(self, value: dict):
        from .encryption import encrypt_env_json
        self._headers_json_encrypted = encrypt_env_json(value or {})

    @property
    def env_json(self) -> dict:
        from .encryption import decrypt_env_json
        return decrypt_env_json(self._env_json_encrypted)

    @env_json.setter
    def env_json(self, value: dict):
        from .encryption import encrypt_env_json
        self._env_json_encrypted = encrypt_env_json(value or {})

    @property
    def oauth_json(self) -> dict:
        from .encryption import decrypt_env_json
        return decrypt_env_json(self._oauth_json_encrypted)

    @oauth_json.setter
    def oauth_json(self, value: dict):
        from .encryption import encrypt_env_json
        self._oauth_json_encrypted = encrypt_env_json(value or {})


class MCPOAuthAttempt(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    server = models.ForeignKey(MCPServer, on_delete=models.CASCADE, related_name='oauth_attempts')
    state_hash = models.CharField(max_length=64, unique=True)
    completion_hash = models.CharField(max_length=64)
    config_encrypted = models.TextField()
    expires_at = models.DateTimeField()
    consumed = models.BooleanField(default=False)


class MCPServerTool(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    server = models.ForeignKey(MCPServer, on_delete=models.CASCADE, related_name='tools')
    name = models.CharField(max_length=255)
    description = models.TextField(default='', blank=True)
    input_schema = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('server', 'name')
        ordering = ['name']

    def __str__(self):
        return f"{self.name} [{self.server.name}]"


class MCPToolExecution(models.Model):
    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    server = models.ForeignKey(MCPServer, on_delete=models.CASCADE, related_name='executions')
    tool_name = models.CharField(max_length=255)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='mcp_executions')
    arguments = models.JSONField(default=dict, blank=True)
    result = models.TextField(blank=True, default="")
    error = models.TextField(blank=True, default="")
    duration_ms = models.PositiveIntegerField(default=0)
    success = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['server', '-created_at']),
            models.Index(fields=['user', '-created_at']),
        ]

    def __str__(self):
        return f"{self.tool_name} on {self.server.name} ({'success' if self.success else 'failed'})"
