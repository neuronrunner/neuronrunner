import re

from chat.models import Request
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import models
from rest_framework import serializers
from rest_framework.exceptions import NotAuthenticated
from utils.image_placeholders import build_blur_data_url

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    otp = serializers.CharField(write_only=True, required=True)
    runs = serializers.SerializerMethodField()
    followers_count = serializers.SerializerMethodField()
    following_count = serializers.SerializerMethodField()
    is_following = serializers.SerializerMethodField()
    profile_picture_blur_data_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ('uuid', 'username', 'email', 'password',
                  'first_name', 'last_name', 'bio', 'profile_picture', 'profile_picture_blur_data_url', 'otp', 'runs',
                  'followers_count', 'following_count', 'is_following',
                  'preferred_name', 'memory_enabled', 'is_staff', 'is_superuser')
        extra_kwargs = {
            'password': {'write_only': True},
            'username': {'required': True},
            'email': {'required': True},
            'is_staff': {'read_only': True},
            'is_superuser': {'read_only': True},
        }

    def validate_email(self, value):
        try:
            validate_email(value)
        except ValidationError as exc:
            raise serializers.ValidationError("Enter a valid email address.") from exc
        user = getattr(self, 'instance', None)
        qs = User.objects.filter(email__iexact=value)
        if user:
            qs = qs.exclude(pk=user.pk)
        if qs.exists():
            raise serializers.ValidationError("A user with this email already exists.")
        return value

    def validate_username(self, value):
        if not re.match(settings.USERNAME_REGEX, value):
            raise serializers.ValidationError(
                "Username must be 3–30 characters long and contain only letters, numbers, underscores (_) or dots (.)"
            )
        if value.lower() in settings.RESERVED_USERNAMES:
            raise serializers.ValidationError("This username is reserved.")
        if value.startswith('.') or value.endswith('.') or '..' in value:
            raise serializers.ValidationError("Username cannot start/end with dot or contain consecutive dots.")
        if value.startswith('_') or value.endswith('_') or '__' in value:
            raise serializers.ValidationError("Username cannot start/end with underscore or contain consecutive underscores.")
        user = getattr(self, 'instance', None)
        qs = User.objects.filter(username__iexact=value)
        if user:
            qs = qs.exclude(pk=user.pk)
        if qs.exists():
            raise serializers.ValidationError("A user with this username already exists.")
        return value

    def validate_profile_picture(self, value):
        if value and value.size > settings.PROFILE_PICTURE_MAX_SIZE:
            raise serializers.ValidationError(
                f"Image file too large. Size cannot exceed {settings.PROFILE_PICTURE_MAX_SIZE / (1024 * 1024)} MB.")
        return value

    def to_representation(self, instance):
        data = super().to_representation(instance)
        from core.extensions import registry as ext_registry
        extra = ext_registry.app.extra_user_payload(instance)
        if extra:
            data.update(extra)
        return data

    def to_internal_value(self, data):
        if 'profile_picture' in data and data['profile_picture'] == '':
            data = data.copy()
            data['profile_picture'] = None
        return super().to_internal_value(data)

    def create(self, validated_data):
        validated_data.pop('otp', None)  # Remove otp before creating user
        password = validated_data.pop('password', None)
        user = User.objects.create_user(password=password, **validated_data)
        return user

    def update(self, instance, validated_data):
        # Prevent attempting DB operations on None
        if instance is None:
            raise NotAuthenticated("Authentication credentials were not provided.")

        validated_data.pop('otp', None)  # Remove otp if present
        self.handle_picture_change(instance, validated_data)

        # Update other fields dynamically
        for field in ['email', 'username', 'first_name', 'last_name', 'bio', 'profile_picture', 'preferred_name', 'memory_enabled']:
            if field in validated_data:
                setattr(instance, field, validated_data[field])

        instance.save()
        return instance

    def handle_picture_change(self, instance, validated_data):
        # Handle profile picture changes
        if 'profile_picture' in validated_data:
            new_picture = validated_data['profile_picture']

            if instance.profile_picture:
                if not new_picture or (new_picture and instance.profile_picture.name != new_picture.name):
                    instance.profile_picture.delete(save=False)

            instance.profile_picture = new_picture

    def to_representation(self, instance):
        if instance is None:
            return {}
        data = super().to_representation(instance)
        request = self.context.get('request')
        # Only expose private account fields to the account owner or staff
        is_owner = request and request.user and request.user.is_authenticated and (
            request.user == instance or getattr(request.user, 'is_staff', False) or getattr(request.user, 'is_superuser', False)
        )
        if not is_owner:
            for field in ('email', 'memory_enabled'):
                data.pop(field, None)
        return data

    def get_runs(self, obj):
        """Get total runs count for all models owned by this user"""
        if obj is None:
            return 0
        return Request.objects.filter(model__author=obj).count()

    def get_followers_count(self, obj):
        """Get the number of followers"""
        if obj is None:
            return 0
        return obj.followers.count()

    def get_following_count(self, obj):
        """Get the number of users this user is following"""
        if obj is None:
            return 0
        return obj.following.count()

    def get_is_following(self, obj):
        """Check if the current user is following this user"""
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False
        if obj is None:
            return False
        return request.user.following.filter(pk=obj.pk).exists()

    def get_profile_picture_blur_data_url(self, obj):
        return build_blur_data_url(obj.profile_picture, cache_prefix='placeholder:profile-picture')
