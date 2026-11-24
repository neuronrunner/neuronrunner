"""
DiscussionPostViewSet - model discussion threads and replies.
"""
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from model.models import DiscussionPost, DiscussionReply, Model
from model.serializers import DiscussionPostSerializer, DiscussionReplySerializer

from .permissions import IsAuthorOrReadOnly


class DiscussionPostViewSet(viewsets.ModelViewSet):
    serializer_class = DiscussionPostSerializer
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly]
    lookup_field = 'uuid'

    def get_queryset(self):
        model_name = self.kwargs['model_name']
        user = self.request.user

        base_query = (
            DiscussionPost.objects
            .filter(model__name=model_name)
            .select_related('author', 'model')
            .annotate(reply_count=Count('replies'))
            .order_by('created_at')
        )

        if not user.is_authenticated:
            return base_query.filter(model__is_public=True)

        return base_query.filter(Q(model__is_public=True) | Q(model__author=user))

    def perform_create(self, serializer):
        user = self.request.user

        visible_models = Model.objects.filter(name=self.kwargs['model_name'])
        if not user.is_authenticated:
            visible_models = visible_models.filter(is_public=True)
        else:
            visible_models = visible_models.filter(Q(is_public=True) | Q(author=user))

        model = get_object_or_404(visible_models)
        serializer.save(author=user, model=model)

    @action(detail=True, methods=['get', 'post'], url_path='replies')
    def replies(self, request, model_name=None, uuid=None):
        discussion = self.get_object()

        if request.method == 'GET':
            replies = (
                DiscussionReply.objects
                .filter(discussion=discussion)
                .select_related('author', 'discussion')
                .order_by('created_at')
            )
            return Response(DiscussionReplySerializer(replies, many=True).data)

        if not request.user.is_authenticated:
            return Response({'detail': 'Authentication credentials were not provided.'}, status=status.HTTP_401_UNAUTHORIZED)

        serializer = DiscussionReplySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        reply = DiscussionReply.objects.create(
            discussion=discussion,
            author=request.user,
            body=serializer.validated_data['body'],
        )
        return Response(DiscussionReplySerializer(reply).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'replies/(?P<reply_uuid>[^/.]+)')
    def delete_reply(self, request, model_name=None, uuid=None, reply_uuid=None):
        discussion = self.get_object()
        reply = get_object_or_404(DiscussionReply, uuid=reply_uuid, discussion=discussion)
        self.check_object_permissions(request, reply)
        reply.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
