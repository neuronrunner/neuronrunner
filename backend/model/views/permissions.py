"""
Shared permissions and pagination for the model app.
"""
from rest_framework import permissions
from rest_framework.pagination import PageNumberPagination

from model.models import Model


class IsAuthorOrReadOnly(permissions.BasePermission):
    """Custom permission to only allow authors and superusers to modify objects."""

    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True

        # Superusers can edit everything
        if request.user and request.user.is_superuser:
            return True

        # For models
        if isinstance(obj, Model):
            return obj.author == request.user

        # For tags and related objects
        if hasattr(obj, 'model') and hasattr(obj.model, 'author'):
            return obj.model.author == request.user

        # For direct ownership
        if hasattr(obj, 'author'):
            return obj.author == request.user

        return False


class ModelPagination(PageNumberPagination):
    page_size = 10
    page_size_query_param = 'page_size'
    max_page_size = 100

    # Support 'limit' as an alias for 'page_size'
    def get_page_size(self, request):
        limit = request.query_params.get('limit')
        if limit is not None:
            try:
                return min(int(limit), self.max_page_size)
            except (TypeError, ValueError):
                pass
        return super().get_page_size(request)
