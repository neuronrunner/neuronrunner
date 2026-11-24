import re

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from rest_framework import serializers
from utils.image_placeholders import build_blur_data_url

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    otp = serializers.CharField(write_only=True, required=True)
    profile_picture_blur_data_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ('uuid', 'username', 'email', 'password',
                  'first_name', 'last_name', 'bio', 'profile_picture', 'profile_picture_blur_data_url', 'otp',
                  'is_staff', 'is_superuser')
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
        except ValidationError:
            raise serializers.ValidationError("Enter a valid email address.")
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
        return value

    def validate_profile_picture(self, value):
        if value and value.size > 10 * 1024 * 1024:  # 10MB limit
            raise serializers.ValidationError(
                "Image file too large. Size cannot exceed 10 MB.")
        return value

    def create(self, validated_data):
        validated_data.pop('otp', None)  # Remove otp before creating user
        password = validated_data.pop('password', None)
        # Set preferred_name to firstname if present
        first_name = validated_data.get('first_name')
        if first_name is not None:
            validated_data['preferred_name'] = first_name
        user = User.objects.create_user(password=password, **validated_data)
        return user

    def update(self, instance, validated_data):
        validated_data.pop('otp', None)  # Remove otp if present
        # Handle password update
        if 'password' in validated_data:
            instance.set_password(validated_data.pop('password'))

        # Update other fields dynamically
        for field in ['email', 'username', 'first_name', 'last_name', 'bio', 'profile_picture']:
            if field in validated_data:
                setattr(instance, field, validated_data[field])

        instance.save()
        return instance

    def get_profile_picture_blur_data_url(self, obj):
        return build_blur_data_url(obj.profile_picture, cache_prefix='placeholder:profile-picture')


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(required=False)
    email = serializers.EmailField(required=False)
    password = serializers.CharField(style={'input_type': 'password'})

    def validate(self, data):
        username = data.get('username')
        email = data.get('email')
        password = data.get('password')

        if not (username or email) or not password:
            raise serializers.ValidationError(
                "Must provide username/email and password.")

        if username and email:
            raise serializers.ValidationError(
                "Provide either username or email, not both.")

        user = None
        if username:
            user = authenticate(username=username, password=password)

        if email and not user:
            try:
                user = User.objects.get(email=email)
                user = authenticate(username=user.username, password=password)
            except User.DoesNotExist:
                pass

        if not user or not user.is_active:
            raise serializers.ValidationError(
                "Unable to log in with provided credentials.")

        data['user'] = user
        return data

class SocialAuthSerializer(serializers.Serializer):
    provider = serializers.CharField(max_length=20)
    access_token = serializers.CharField(max_length=2000)
