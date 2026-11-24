from chat.models import Request
from rest_framework import serializers
from sandbox.services.provider_keys import BYOS_PROVIDERS
from utils.cache import get_warm_models_count

from .models import (
    DiscussionPost,
    DiscussionReply,
    LLMConfig,
    Model,
    ModelDownloadTask,
)
from .reasoning import get_model_reasoning_spec


class LLMConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = LLMConfig
        fields = [
            'context_length', 'max_tokens', 'default_temperature', 'default_top_p',
            'reasoning_mode', 'supported_reasoning_efforts', 'default_reasoning_effort',
            'system_prompt', 'chat_template', 'supports_tools', 'quantization',
            'external_url', 'external_model_id',
        ]


class ModelDownloadTaskSerializer(serializers.ModelSerializer):
    class Meta:
        model = ModelDownloadTask
        fields = [
            'uuid', 'repo_id', 'status', 'progress_percentage', 'total_size_bytes',
            'downloaded_size_bytes', 'download_speed_bps', 'duration_seconds',
            'error_message', 'retry_count', 'created_at', 'started_at', 'completed_at',
        ]


class DynamicFieldsModelSerializer(serializers.ModelSerializer):
    def __init__(self, *args, **kwargs):
        fields = kwargs.pop('fields', None)
        super().__init__(*args, **kwargs)
        if fields is not None:
            allowed = set(fields)
            existing = set(self.fields)
            for field_name in existing - allowed:
                self.fields.pop(field_name)


class ModelSerializer(DynamicFieldsModelSerializer):
    author = serializers.SlugRelatedField(
        slug_field='username',
        read_only=True,
        default=serializers.CurrentUserDefault()
    )
    runs = serializers.SerializerMethodField()
    likes_count = serializers.SerializerMethodField()
    is_liked = serializers.SerializerMethodField()
    current_status = serializers.SerializerMethodField()
    gpu_display = serializers.SerializerMethodField()
    llm_config = LLMConfigSerializer(read_only=True)
    latest_download_task = serializers.SerializerMethodField()
    slug = serializers.CharField(source='name', read_only=True)
    type = serializers.CharField(source='model_type', read_only=True)
    display_name = serializers.SerializerMethodField()
    clip_l_path = serializers.SerializerMethodField()
    vae_path = serializers.SerializerMethodField()
    t5xxl_path = serializers.SerializerMethodField()
    trigger_words = serializers.SerializerMethodField()
    architecture = serializers.SerializerMethodField()
    category = serializers.SerializerMethodField()
    thumbnail_url = serializers.SerializerMethodField()
    is_byok = serializers.SerializerMethodField()
    is_byos = serializers.SerializerMethodField()
    reasoning_mode = serializers.SerializerMethodField()
    reasoning_tiers = serializers.SerializerMethodField()
    default_reasoning_effort = serializers.SerializerMethodField()

    def get_category(self, obj):
        return (obj.gpu_requirements or {}).get("category", "LLM" if obj.model_type == "text" else "General")

    def get_thumbnail_url(self, obj):
        return (obj.gpu_requirements or {}).get("thumbnail_url", "")

    def get_display_name(self, obj):
        if getattr(obj, 'display_name', ''):
            return obj.display_name
        if obj.description:
            return obj.description
        if obj.storage_path and obj.storage_path.startswith("hf/"):
            return obj.storage_path[3:]
        return obj.name

    def get_is_byok(self, obj):
        return bool(obj.workspace_id or getattr(obj, 'provider_key_id', None))

    def get_is_byos(self, obj):
        provider_name = getattr(obj, 'provider_name', '') or ''
        name = getattr(obj, 'name', '') or ''
        return bool(
            provider_name in BYOS_PROVIDERS
            or (name.startswith('ws-') and '-byos-' in name)
        )

    def get_reasoning_mode(self, obj):
        return get_model_reasoning_spec(obj)["mode"]

    def get_reasoning_tiers(self, obj):
        return get_model_reasoning_spec(obj)["tiers"]

    def get_default_reasoning_effort(self, obj):
        return get_model_reasoning_spec(obj)["default"]

    def get_clip_l_path(self, obj):
        return (obj.gpu_requirements or {}).get("clip_l_path", "")

    def get_vae_path(self, obj):
        return (obj.gpu_requirements or {}).get("vae_path", "")

    def get_t5xxl_path(self, obj):
        return (obj.gpu_requirements or {}).get("t5xxl_path", "")

    def get_trigger_words(self, obj):
        return (obj.gpu_requirements or {}).get("trigger_words", "") or obj.readme

    def get_architecture(self, obj):
        return (obj.gpu_requirements or {}).get("architecture", "")

    class Meta:
        model = Model
        fields = [
            'uuid', 'name', 'slug', 'display_name', 'type', 'description', 'created_at', 'is_public',
            'author', 'model_type', 'runner', 'source', 'storage_path',
            'file_size_bytes', 'status', 'status_message', 'gpu_display',
            'gpu_requirements', 'is_reasoning', 'reasoning_mode', 'reasoning_tiers',
            'default_reasoning_effort', 'supports_vision', 'is_free_tier', 'is_external', 'external_url',
            'input_price', 'output_price', 'cache_read_price',
            'wholesale_input_price', 'wholesale_output_price', 'wholesale_cache_read_price',
            'external_model_id', 'readme', 'runs', 'likes_count', 'is_liked',
            'current_status', 'llm_config', 'latest_download_task',
            'benchmark_scores', 'llm_stats_id', 'context_length',
            'clip_l_path', 'vae_path', 't5xxl_path', 'trigger_words', 'architecture',
            'category', 'thumbnail_url', 'is_byok', 'is_byos', 'provider_name', 'workspace',
        ]
        read_only_fields = [
            'input_price', 'output_price', 'cache_read_price',
            'wholesale_input_price', 'wholesale_output_price', 'wholesale_cache_read_price',
            'uuid', 'slug', 'display_name', 'type', 'created_at', 'author', 'runs', 'likes_count', 'is_liked', 'current_status', 'gpu_display', 'category', 'thumbnail_url', 'is_byok', 'is_byos', 'reasoning_mode', 'reasoning_tiers', 'default_reasoning_effort',
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get('request')
        include_wholesale = bool(self.context.get('include_wholesale')) or bool(
            request and getattr(request, 'user', None) and request.user.is_authenticated and (
                getattr(request.user, 'is_staff', False) or getattr(request.user, 'is_superuser', False)
            )
        )
        if not include_wholesale:
            for field in ('wholesale_input_price', 'wholesale_output_price', 'wholesale_cache_read_price'):
                data.pop(field, None)
        return data

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance is not None and 'name' in self.fields:
            self.fields['name'].read_only = True

    def create(self, validated_data):
        if Model.objects.filter(name=validated_data['name'], author=self.context['request'].user).exists():
            raise serializers.ValidationError('Model with this name already exists')
        validated_data['author'] = self.context['request'].user
        return super().create(validated_data)

    def validate_name(self, value):
        queryset = Model.objects.filter(name=value, author=self.context['request'].user)
        if self.instance is not None:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError('Model with this name already exists')
        return value

    def validate_description(self, value):
        if len(value) < 64:
            raise serializers.ValidationError('Description must be at least 64 characters long.')
        return value

    def get_runs(self, obj):
        return Request.objects.filter(model=obj).count()

    def get_likes_count(self, obj):
        return obj.liked_by.count()

    def get_is_liked(self, obj):
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False
        return obj.liked_by.filter(pk=request.user.pk).exists()

    def get_current_status(self, obj):
        if obj.is_external:
            return "always_warm"
        if get_warm_models_count(str(obj.uuid)):
            return "warm"
        return "cold"

    def get_gpu_display(self, obj):
        return ""

    def get_latest_download_task(self, obj):
        task = obj.download_tasks.first()
        if task:
            return ModelDownloadTaskSerializer(task).data
        return None


class DiscussionPostSerializer(serializers.ModelSerializer):
    author = serializers.SlugRelatedField(slug_field='username', read_only=True)
    model = serializers.SlugRelatedField(slug_field='name', read_only=True)
    reply_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = DiscussionPost
        fields = ['uuid', 'model', 'author', 'title', 'body', 'created_at', 'reply_count']
        read_only_fields = ['uuid', 'model', 'author', 'created_at', 'reply_count']

    def validate_title(self, value):
        title = (value or '').strip()
        if not title:
            raise serializers.ValidationError('Title cannot be empty')
        if len(title) > 200:
            raise serializers.ValidationError('Title is too long')
        return title

    def validate_body(self, value):
        body = (value or '').strip()
        if not body:
            raise serializers.ValidationError('Body cannot be empty')
        if len(body) > 4000:
            raise serializers.ValidationError('Body is too long')
        return body


class DiscussionReplySerializer(serializers.ModelSerializer):
    author = serializers.SlugRelatedField(slug_field='username', read_only=True)
    discussion = serializers.UUIDField(source='discussion.uuid', read_only=True)

    class Meta:
        model = DiscussionReply
        fields = ['uuid', 'discussion', 'author', 'body', 'created_at']
        read_only_fields = ['uuid', 'discussion', 'author', 'created_at']

    def validate_body(self, value):
        body = (value or '').strip()
        if not body:
            raise serializers.ValidationError('Body cannot be empty')
        if len(body) > 4000:
            raise serializers.ValidationError('Body is too long')
        return body
