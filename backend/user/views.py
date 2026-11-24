from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from rest_framework import permissions, status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from .models import ApiKey
from .serializers import UserSerializer

User = get_user_model()


class ChangePasswordThrottle(UserRateThrottle):
    rate = '10/minute'
    scope = 'change_password'


class UserProfileView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, username=None):
        target_user = request.user if username == "me" else User.objects.filter(
            username=username).first()
        if not target_user:
            return Response({"error": "User not found"}, status=status.HTTP_404_NOT_FOUND)

        return Response(UserSerializer(target_user, context={'request': request}).data)

    def patch(self, request, username=None):
        target_user = request.user if username == "me" else User.objects.filter(
            username=username).first()
        if not target_user:
            return Response({"error": "User not found"}, status=status.HTTP_404_NOT_FOUND)

        if target_user != request.user:
            return Response({"error": "Permission denied"}, status=status.HTTP_403_FORBIDDEN)

        serializer = UserSerializer(
            target_user, data=request.data, partial=True, context={'request': request})
        serializer.is_valid(raise_exception=True)
        serializer.save()

        return Response(serializer.data)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def follow_user(request, username):
    """Follow a user"""
    target_user = User.objects.filter(username=username).first()
    if not target_user:
        return Response({"error": "User not found"}, status=status.HTTP_404_NOT_FOUND)

    if target_user == request.user:
        return Response({"error": "You cannot follow yourself"}, status=status.HTTP_400_BAD_REQUEST)

    request.user.following.add(target_user)
    return Response({"success": True, "is_following": True})


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def unfollow_user(request, username):
    """Unfollow a user"""
    target_user = User.objects.filter(username=username).first()
    if not target_user:
        return Response({"error": "User not found"}, status=status.HTTP_404_NOT_FOUND)

    request.user.following.remove(target_user)
    return Response({"success": True, "is_following": False})


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
@throttle_classes([ChangePasswordThrottle])
def change_password(request):
    user = request.user
    current_password = request.data.get("current_password")
    new_password = request.data.get("new_password")
    if not current_password or not new_password:
        return Response({"error": "Current password and new password are required."}, status=status.HTTP_400_BAD_REQUEST)

    if not user.check_password(current_password):
        return Response({"error": "Current password is incorrect."}, status=status.HTTP_400_BAD_REQUEST)

    try:
        validate_password(new_password, user=user)
    except ValidationError as exc:
        return Response({"error": exc.messages[0]}, status=status.HTTP_400_BAD_REQUEST)

    user.set_password(new_password)
    user.save(update_fields=['password'])

    return Response({"success": "Password changed successfully."})


class ApiKeyListCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        """List all API keys for the authenticated user."""
        keys = ApiKey.objects.filter(user=request.user)
        data = [
            {
                "id": str(key.id),
                "name": key.name,
                "prefix": key.prefix,
                "created_at": key.created_at.isoformat(),
                "last_used_at": key.last_used_at.isoformat() if key.last_used_at else None,
                "is_active": key.is_active,
            }
            for key in keys
        ]
        return Response(data)

    def post(self, request):
        """Create a new API key."""
        name = request.data.get("name", "").strip()
        if not name:
            return Response(
                {"error": "Name is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(name) > 100:
            return Response(
                {"error": "Name must be 100 characters or less."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Limit number of keys per user
        if ApiKey.objects.filter(user=request.user).count() >= 10:
            return Response(
                {"error": "You can have at most 10 API keys."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        key_instance, raw_key = ApiKey.create_key(user=request.user, name=name)
        return Response(
            {
                "id": str(key_instance.id),
                "name": key_instance.name,
                "prefix": key_instance.prefix,
                "key": raw_key,
                "created_at": key_instance.created_at.isoformat(),
            },
            status=status.HTTP_201_CREATED,
        )


class ApiKeyDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self, request, key_id):
        try:
            return ApiKey.objects.get(id=key_id, user=request.user)
        except ApiKey.DoesNotExist:
            return None

    def delete(self, request, key_id):
        """Delete an API key."""
        key = self.get_object(request, key_id)
        if not key:
            return Response(
                {"error": "API key not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        key.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def patch(self, request, key_id):
        """Update an API key (e.g. deactivate/activate)."""
        key = self.get_object(request, key_id)
        if not key:
            return Response(
                {"error": "API key not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        is_active = request.data.get("is_active")
        if is_active is not None:
            # ensure boolean
            key.is_active = bool(is_active)
            key.save()

        return Response({
            "id": str(key.id),
            "name": key.name,
            "prefix": key.prefix,
            "created_at": key.created_at.isoformat(),
            "last_used_at": key.last_used_at.isoformat() if key.last_used_at else None,
            "is_active": key.is_active,
        })
