"""
Legacy TagViewSet compatibility adapter.
"""
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, viewsets
from rest_framework.response import Response

from model.models import Model
from model.serializers import ModelSerializer

from .permissions import IsAuthorOrReadOnly


class TagViewSet(viewsets.ViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly]

    def list(self, request, model_name=None):
        model = get_object_or_404(Model, name=model_name)
        data = ModelSerializer(model, context={'request': request}).data
        return Response([data])

    def create(self, request, model_name=None):
        model = get_object_or_404(Model, name=model_name)
        self.check_object_permissions(request, model)
        serializer = ModelSerializer(model, data=request.data, partial=True, context={'request': request})
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    def retrieve(self, request, model_name=None, name=None):
        model = get_object_or_404(Model, name=model_name)
        return Response(ModelSerializer(model, context={'request': request}).data)

    def partial_update(self, request, model_name=None, name=None):
        model = get_object_or_404(Model, name=model_name)
        self.check_object_permissions(request, model)
        serializer = ModelSerializer(model, data=request.data, partial=True, context={'request': request})
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def destroy(self, request, model_name=None, name=None):
        return Response(status=status.HTTP_204_NO_CONTENT)

    def reorder(self, request, model_name=None):
        return Response({"status": "ok"})

    def remove_file(self, request, model_name=None, name=None):
        return Response({"status": "ok"})

    def move_up(self, request, model_name=None, name=None):
        return Response({"status": "ok"})

    def move_down(self, request, model_name=None, name=None):
        return Response({"status": "ok"})

    def download(self, request, model_name=None, name=None):
        model = get_object_or_404(Model, name=model_name)
        return Response({"storage_path": model.storage_path})

    def test_model(self, request, model_name=None, name=None):
        return Response({"status": "ok"})
