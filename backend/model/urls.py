from django.urls import path

from core.extensions import expand_urlpatterns, registry as _ext_registry
from .views import DiscussionPostViewSet, ModelViewSet, TagViewSet, gpu_list

urlpatterns = [
    *expand_urlpatterns(_ext_registry.app.extra_model_urlpatterns),

    path('gpus/', gpu_list, name='gpu-list'),
    path('check-name/<str:name>/', ModelViewSet.as_view({
        'get': 'check_name_availability'
    }), name='check-name-availability'),
    path('', ModelViewSet.as_view({
        'get': 'list',
        'post': 'create'
    }), name='model-list'),
    path('<str:model_name>/', ModelViewSet.as_view({
        'get': 'retrieve',
        'patch': 'partial_update',
        'delete': 'destroy'
    }), name='model-detail'),
    path('<str:model_name>/like/', ModelViewSet.as_view({
        'post': 'like_model'
    }), name='model-like'),
    path('<str:model_name>/unlike/', ModelViewSet.as_view({
        'post': 'unlike_model'
    }), name='model-unlike'),
    path('<str:model_name>/tags/', TagViewSet.as_view({
        'get': 'list',
        'post': 'create',
    }), name='tag-list'),
    path('<str:model_name>/tags/reorder/', TagViewSet.as_view({
        'post': 'reorder'
    }), name='tag-reorder'),
    path('<str:model_name>/tags/<str:name>/', TagViewSet.as_view({
        'get': 'retrieve',
        'patch': 'partial_update',
        'delete': 'destroy'
    }), name='tag-detail'),
    path('<str:model_name>/tags/<str:name>/remove_file/', TagViewSet.as_view({
        'post': 'remove_file'
    }), name='tag-remove-file'),
    path('<str:model_name>/tags/<str:name>/moveup/', TagViewSet.as_view({
        'post': 'move_up'
    }), name='tag-move-up'),
    path('<str:model_name>/tags/<str:name>/movedown/', TagViewSet.as_view({
        'post': 'move_down'
    }), name='tag-move-down'),
    path('<str:model_name>/tags/<str:name>/download/', TagViewSet.as_view({
        'get': 'download'
    }), name='tag-download'),
    path('<str:model_name>/tags/<str:name>/test/', TagViewSet.as_view({
        'post': 'test_model'
    }), name='tag-test-model'),

    path('<str:model_name>/discussions/', DiscussionPostViewSet.as_view({
        'get': 'list',
        'post': 'create',
    }), name='discussion-list'),
    path('<str:model_name>/discussions/<uuid:uuid>/', DiscussionPostViewSet.as_view({
        'get': 'retrieve',
        'delete': 'destroy',
    }), name='discussion-detail'),
    path('<str:model_name>/discussions/<uuid:uuid>/replies/', DiscussionPostViewSet.as_view({
        'get': 'replies',
        'post': 'replies',
    }), name='discussion-replies'),
    path('<str:model_name>/discussions/<uuid:uuid>/replies/<uuid:reply_uuid>/', DiscussionPostViewSet.as_view({
        'delete': 'delete_reply',
    }), name='discussion-reply-detail'),
]
