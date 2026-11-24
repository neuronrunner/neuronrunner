from django.contrib import admin

from .models import Conversation, Image, ImageCategory, Memory, Message, Request


class MessageInline(admin.TabularInline):
    model = Message
    extra = 0
    readonly_fields = ('created_at',)
    fields = ('role', 'content', 'created_at')

@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'title', 'user', 'created_at')
    list_filter = ('created_at', 'user')
    search_fields = ('title', 'user__username', 'uuid')
    readonly_fields = ('uuid', 'created_at')
    inlines = [MessageInline]
    date_hierarchy = 'created_at'

@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'conversation', 'role', 'parent', 'created_at')
    list_filter = ('role', 'created_at')
    search_fields = ('content', 'conversation__title')
    readonly_fields = ('uuid', 'created_at')
    raw_id_fields = ('conversation', 'parent')

@admin.register(Request)
class RequestAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'model', 'status', 'user', 'created_at')
    list_filter = ('status', 'created_at')
    search_fields = ('model__name', 'user__username')
    readonly_fields = ('created_at', 'started_at', 'completed_at')
    raw_id_fields = ('conversation',)

@admin.register(Image)
class ImageAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'message', 'model', 'width', 'height', 'seed', 'shared', 'created_at')
    list_filter = ('created_at', 'shared', 'related_categories', 'nsfw', 'width', 'height')
    search_fields = ('prompt', 'message__uuid')
    readonly_fields = ('uuid', 'created_at')
    raw_id_fields = ('message',)


@admin.register(ImageCategory)
class ImageCategoryAdmin(admin.ModelAdmin):
    list_display = ('name', 'created_at')
    search_fields = ('name',)
    ordering = ('name',)

@admin.register(Memory)
class MemoryAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'content', 'category', 'importance_score', 'last_accessed_at', 'created_at')
    list_filter = ('created_at', 'category', 'importance_score')
    search_fields = ('content',)
    readonly_fields = ('uuid', 'created_at', 'last_accessed_at')
