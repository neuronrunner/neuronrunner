from django.contrib import admin

from .models import MCPServer, MCPServerTool


class MCPServerToolInline(admin.TabularInline):
    model = MCPServerTool
    extra = 0
    readonly_fields = ('uuid', 'created_at')
    fields = ('name', 'description', 'created_at')


@admin.register(MCPServer)
class MCPServerAdmin(admin.ModelAdmin):
    list_display = ('name', 'user', 'transport', 'enabled', 'created_at')
    list_filter = ('transport', 'enabled', 'created_at')
    search_fields = ('name', 'user__username', 'command')
    readonly_fields = ('uuid', 'created_at', 'updated_at')
    inlines = [MCPServerToolInline]
