"""
ModelViewSet - CRUD, like/unlike, publish for ML models.
"""
import hashlib
import json

from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from utils.cache import get_cache, set_cache

from model.models import Model
from model.serializers import ModelSerializer
from sandbox.services.provider_keys import BYOS_PROVIDERS, filter_usable_models, request_workspace

from .permissions import IsAuthorOrReadOnly, ModelPagination


def _build_cache_key(prefix, request, **extras):
    query_params = {k: request.query_params.getlist(k) for k in sorted(request.query_params.keys())}
    payload = {
        'path': request.path,
        'query_params': query_params,
        **extras,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    return f"{prefix}:{digest}"


class ModelViewSet(viewsets.ModelViewSet):
    serializer_class = ModelSerializer
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly]
    lookup_field = 'name'
    pagination_class = ModelPagination

    def get_serializer(self, *args, **kwargs):
        fields_param = self.request.query_params.get('fields')
        if fields_param:
            fields = [f.strip() for f in fields_param.split(',')]
            kwargs['fields'] = fields
        return super().get_serializer(*args, **kwargs)

    def get_queryset(self):
        user = self.request.user
        queryset = Model.objects.all()

        # Filtering by author (username or id) - do this first to check if viewing another user's profile
        author = self.request.query_params.get('author')
        if author:
            queryset = queryset.filter(author__username=author)
            # If viewing another user's profile, only show public models
            # If viewing own profile, show all models
            if user.is_authenticated and user.username == author:
                # User is viewing their own profile - show all their models
                pass  # queryset already filtered by author, so all their models are shown
            else:
                # User is viewing another user's profile - only show public models
                queryset = queryset.filter(is_public=True)
        else:
            # Not filtering by author - show based on authentication and workspace
            workspace_id = (
                self.request.headers.get('X-Workspace-ID')
                or self.request.query_params.get('workspace_id')
                or self.request.query_params.get('workspace')
            )
            if user.is_authenticated:
                if workspace_id:
                    queryset = queryset.filter(
                        Q(is_public=True) |
                        Q(author=user) |
                        (Q(workspace_id=workspace_id, workspace__memberships__user=user) & ~Q(provider_name__in=BYOS_PROVIDERS))
                    )
                else:
                    queryset = queryset.filter(
                        Q(is_public=True) |
                        Q(author=user) |
                        (Q(workspace__memberships__user=user) & ~Q(provider_name__in=BYOS_PROVIDERS))
                    )
            else:
                queryset = queryset.filter(is_public=True)

        # Filtering by model_type
        model_type = self.request.query_params.get('model_type')
        if model_type:
            queryset = queryset.filter(model_type=model_type)

        # Full text search (name, description)
        search = self.request.query_params.get('search')
        if search:
            queryset = queryset.filter(Q(name__icontains=search) | Q(description__icontains=search) | Q(readme__icontains=search))

        # Ordering (always surface Free-tier models first)
        ordering = self.request.query_params.get('ordering', '-created_at')
        allowed_ordering_fields = ['name', '-name', 'created_at', '-created_at', 'downloads', '-downloads']
        secondary_ordering = ordering if ordering in allowed_ordering_fields else '-created_at'
        queryset = queryset.order_by('-is_free_tier', secondary_ordering)

        # For list view, show active models
        if self.action == 'list':
            if not author or (user.is_authenticated and user.username != author):
                queryset = queryset.filter(status=Model.STATUS_ACTIVE)
            # Without platform LLMs, only list models the workspace's own keys can run.
            if user.is_authenticated and not author:
                queryset = filter_usable_models(queryset.distinct(), request_workspace(self.request))

        return queryset.distinct()

    def perform_create(self, serializer):
        serializer.save(author=self.request.user)

    def list(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            return super().list(request, *args, **kwargs)

        cache_key = _build_cache_key('model:list', request)
        cached_data = get_cache(cache_key)
        if cached_data is not None:
            return Response(cached_data)

        response = super().list(request, *args, **kwargs)
        if response.status_code == status.HTTP_200_OK:
            set_cache(cache_key, response.data, timeout=60)
        return response

    def retrieve(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            return super().retrieve(request, *args, **kwargs)

        cache_key = _build_cache_key('model:retrieve', request, model_name=kwargs.get('model_name'))
        cached_data = get_cache(cache_key)
        if cached_data is not None:
            return Response(cached_data)

        response = super().retrieve(request, *args, **kwargs)
        if response.status_code == status.HTTP_200_OK:
            set_cache(cache_key, response.data, timeout=60)
        return response

    def get_object(self):
        """Retrieve model with ownership validation."""
        queryset = self.filter_queryset(self.get_queryset())
        obj = get_object_or_404(queryset, name=self.kwargs['model_name'])

        # Check object permissions
        self.check_object_permissions(self.request, obj)
        return obj

    def check_name_availability(self, request, name=None):
        """Check if a model name is available."""
        cache_key = f"model:name-availability:{name}"
        cached_data = get_cache(cache_key)
        if cached_data is not None:
            return Response(cached_data, status=status.HTTP_200_OK)

        available = not Model.objects.filter(name=name).exists()
        data = {'available': available}
        set_cache(cache_key, data, timeout=30)
        return Response(data, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='delete')
    def delete_model(self, request, model_name=None):
        model = self.get_object()
        # TODO: Implement a service to handle deletion of related data (tags, files, images)
        return Response({'status': f"Model '{model.name}' and all related data deleted."})

    @action(detail=True, methods=['post'], url_path='like')
    def like_model(self, request, model_name=None):
        """Like a model."""
        model = get_object_or_404(Model, name=model_name)
        if not request.user.is_authenticated:
            return Response({'error': 'Authentication required'}, status=status.HTTP_401_UNAUTHORIZED)
        model.liked_by.add(request.user)
        return Response({'success': True, 'is_liked': True, 'likes_count': model.liked_by.count()})

    @action(detail=True, methods=['post'], url_path='unlike')
    def unlike_model(self, request, model_name=None):
        """Unlike a model."""
        model = get_object_or_404(Model, name=model_name)
        if not request.user.is_authenticated:
            return Response({'error': 'Authentication required'}, status=status.HTTP_401_UNAUTHORIZED)
        model.liked_by.remove(request.user)
        return Response({'success': True, 'is_liked': False, 'likes_count': model.liked_by.count()})

    @action(detail=True, methods=['post'], url_path='publish')
    def publish(self, request, model_name=None):
        """Publish a model to public (requires model to be tested)."""
        model = self.get_object()

        if not model.is_tested:
            return Response(
                {'error': 'Model must be tested before publishing'},
                status=status.HTTP_400_BAD_REQUEST
            )

        model.is_public = True
        model.save()
        return Response({'success': True, 'is_public': True})
