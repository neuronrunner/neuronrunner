from django.conf import settings
from django.db import transaction
from rest_framework import serializers

from .models import MCPServer, MCPServerTool, MCPToolExecution
from .url_security import validate_mcp_url


class MCPServerToolSerializer(serializers.ModelSerializer):
    class Meta:
        model = MCPServerTool
        fields = ['uuid', 'name', 'description', 'input_schema', 'created_at']


class MCPToolExecutionSerializer(serializers.ModelSerializer):
    server_name = serializers.CharField(source='server.name', read_only=True)

    class Meta:
        model = MCPToolExecution
        fields = [
            'uuid', 'server_name', 'tool_name', 'arguments',
            'result', 'error', 'duration_ms', 'success', 'created_at',
        ]


class MCPServerSerializer(serializers.ModelSerializer):
    tools = MCPServerToolSerializer(many=True, read_only=True)
    headers_json = serializers.DictField(child=serializers.CharField(), write_only=True, required=False)
    env_json = serializers.DictField(child=serializers.CharField(), write_only=True, required=False)
    has_headers = serializers.SerializerMethodField()
    has_environment = serializers.SerializerMethodField()
    oauth_connected = serializers.SerializerMethodField()

    @staticmethod
    def _has_oauth_token(obj) -> bool:
        try:
            return bool(obj.oauth_json.get('tokens', {}).get('access_token'))
        except ValueError:
            return False

    def get_oauth_connected(self, obj):
        return obj.auth_type == 'oauth' and self._has_oauth_token(obj)

    def get_has_headers(self, obj):
        return bool(obj._headers_json_encrypted)

    def get_has_environment(self, obj):
        return bool(obj._env_json_encrypted)

    class Meta:
        model = MCPServer
        fields = [
            'uuid', 'name', 'transport',
            'command', 'url', 'env_json', 'workspace',
            'http_transport', 'headers_json', 'has_headers', 'has_environment',
            'auth_type', 'oauth_connected',
            'enabled', 'timeout', 'tools',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['uuid', 'created_at', 'updated_at']

    def validate(self, data):
        transport = data.get('transport', getattr(self.instance, 'transport', 'stdio'))
        command = data.get('command', getattr(self.instance, 'command', ''))
        url = data.get('url', getattr(self.instance, 'url', ''))

        if transport == 'stdio' and getattr(settings, 'REMOTE_ONLY_MCP', True):
            if not self.instance or self.instance.transport != 'stdio':
                raise serializers.ValidationError({
                    'transport': 'Local stdio connectors are no longer supported. Use a remote HTTP/SSE MCP server.'
                })
        if transport == 'stdio' and not command:
            raise serializers.ValidationError({'command': 'Command is required for stdio transport'})
        if transport == 'http' and not url:
            raise serializers.ValidationError({'url': 'URL is required for HTTP transport'})
        if transport == 'http':
            try:
                validate_mcp_url(url)
            except ValueError as exc:
                raise serializers.ValidationError({'url': str(exc)}) from None
        auth_type = data.get('auth_type', getattr(self.instance, 'auth_type', 'manual'))
        if auth_type == 'oauth' and transport != 'http':
            raise serializers.ValidationError({'auth_type': 'OAuth is only available for remote HTTP servers.'})
        if auth_type == 'oauth' and not self.instance:
            data.setdefault('enabled', False)
        if auth_type == 'oauth' and data.get('enabled'):
            if not self.instance or not self._has_oauth_token(self.instance):
                raise serializers.ValidationError({'auth_type': 'Authorize this connector before enabling it.'})
        if transport == 'stdio':
            import shlex
            from .sandbox_transport import authorized_workspace
            workspace = data.get('workspace', getattr(self.instance, 'workspace', None))
            authorized_workspace(self.context['request'].user.pk, getattr(workspace, 'pk', None))
            try:
                if not shlex.split(command):
                    raise ValueError('Empty command')
            except ValueError:
                raise serializers.ValidationError({'command': 'Enter a valid MCP command.'})
        return data

    def create(self, validated_data):
        server = MCPServer.objects.create(user=self.context['request'].user, **validated_data)
        if server.auth_type != 'oauth' and (server.transport != 'stdio' or server.enabled):
            self._refresh_tools(server)
        return server

    @transaction.atomic
    def update(self, instance, validated_data):
        instance = MCPServer.objects.select_for_update().get(pk=instance.pk)
        binding_changed = any(key in validated_data and validated_data[key] != getattr(instance, key)
                              for key in ('url', 'transport', 'auth_type'))
        if binding_changed:
            instance.oauth_json = {}
            instance.oauth_attempts.all().delete()
            instance.tools.all().delete()
            if instance.auth_type == 'oauth' or validated_data.get('auth_type') == 'oauth':
                validated_data['enabled'] = False
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if instance.auth_type != 'oauth' and (instance.transport != 'stdio' or instance.enabled) and any(k in validated_data for k in ('command', 'url', 'transport', 'env_json', 'headers_json', 'http_transport', 'workspace')):
            self._refresh_tools(instance)

        return instance

    def _refresh_tools(self, server, *, raise_errors=False):
        from .services import discover_tools
        from .oauth import server_headers
        try:
            tools = discover_tools(
                command=server.command,
                url=server.url,
                transport=server.transport,
                env_json=server.env_json,
                http_transport=server.http_transport,
                headers_json=server_headers(server),
                server_uuid=str(server.pk),
                timeout=server.timeout,
                user_uuid=str(self.context['request'].user.pk),
                workspace_uuid=str(server.workspace_id) if server.workspace_id else None,
            )
            self._store_tools(server, tools)
        except Exception as e:
            import logging
            from .errors import connection_error_message, error_leaves
            logging.getLogger(__name__).warning("Failed to discover tools for MCP server %s (%s)",
                server.pk, ', '.join(type(leaf).__name__ for leaf in error_leaves(e)))
            # A failed discovery must not leave stale tools active or report success.
            server.enabled = False
            server.save(update_fields=['enabled'])
            if raise_errors:
                raise serializers.ValidationError({'connection': connection_error_message(e)}) from e

    @staticmethod
    def _store_tools(server, tools):
        with transaction.atomic():
            names = []
            for tool in tools:
                names.append(tool['name'])
                MCPServerTool.objects.update_or_create(
                    server=server, name=tool['name'],
                    defaults={
                        'description': tool.get('description', ''),
                        'input_schema': tool.get('input_schema', {}),
                    },
                )
            MCPServerTool.objects.filter(server=server).exclude(name__in=names).delete()
