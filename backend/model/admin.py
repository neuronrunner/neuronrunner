from django.contrib import admin

from .models import (
    DiscussionPost,
    DiscussionReply,
    LLMConfig,
    Model,
    ModelDownloadTask,
    SiteSetting,
)


class LLMConfigInline(admin.StackedInline):
    model = LLMConfig
    extra = 0
    can_delete = False


class ModelDownloadTaskInline(admin.TabularInline):
    model = ModelDownloadTask
    extra = 0
    readonly_fields = (
        "uuid",
        "status",
        "progress_percentage",
        "total_size_bytes",
        "duration_seconds",
        "error_message",
        "created_at",
    )
    fields = (
        "repo_id",
        "status",
        "progress_percentage",
        "total_size_bytes",
        "duration_seconds",
        "error_message",
        "created_at",
    )
    show_change_link = True
    can_delete = False


@admin.register(Model)
class ModelAdmin(admin.ModelAdmin):
    list_display = ('name', 'author', 'model_type', 'runner', 'source', 'status', 'is_reasoning', 'is_public', 'created_at')
    list_filter = ('model_type', 'runner', 'source', 'status', 'is_reasoning', 'is_public', 'created_at')
    search_fields = ('name', 'author__username', 'storage_path')
    readonly_fields = ('uuid', 'created_at')
    inlines = [LLMConfigInline, ModelDownloadTaskInline]
    date_hierarchy = 'created_at'


@admin.register(LLMConfig)
class LLMConfigAdmin(admin.ModelAdmin):
    list_display = ('model', 'context_length', 'max_tokens', 'default_temperature', 'reasoning_mode', 'default_reasoning_effort', 'supports_tools')
    list_filter = ('reasoning_mode', 'default_reasoning_effort', 'supports_tools')
    search_fields = ('model__name',)


@admin.register(ModelDownloadTask)
class ModelDownloadTaskAdmin(admin.ModelAdmin):
    list_display = ('repo_id', 'model', 'status', 'progress_percentage', 'duration_seconds', 'initiated_by', 'created_at')
    list_filter = ('status', 'created_at')
    search_fields = ('repo_id', 'model__name', 'external_task_id')
    readonly_fields = ('uuid', 'created_at', 'started_at', 'completed_at', 'duration_seconds')


@admin.register(DiscussionPost)
class DiscussionPostAdmin(admin.ModelAdmin):
    list_display = ('model', 'author', 'created_at')
    list_filter = ('created_at',)
    search_fields = ('model__name', 'author__username', 'body')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(DiscussionReply)
class DiscussionReplyAdmin(admin.ModelAdmin):
    list_display = ('discussion', 'author', 'created_at')
    list_filter = ('created_at',)
    search_fields = ('discussion__model__name', 'author__username', 'body')
    readonly_fields = ('created_at', 'updated_at')


@admin.register(SiteSetting)
class SiteSettingAdmin(admin.ModelAdmin):
    list_display = ('id', 'scaledown_window', 'updated_at')
    list_display_links = ('id',)
    list_editable = ('scaledown_window',)
