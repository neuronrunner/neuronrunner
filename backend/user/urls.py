from django.urls import path

from core.extensions import expand_urlpatterns, registry as _ext_registry
from . import views

urlpatterns = [
    path('change-password/', views.change_password, name='change-password'),
    path('api-keys/', views.ApiKeyListCreateView.as_view(), name='api-key-list-create'),
    path('api-keys/<uuid:key_id>/', views.ApiKeyDetailView.as_view(), name='api-key-detail'),
    *expand_urlpatterns(_ext_registry.app.extra_user_urlpatterns),
    path('<str:username>/', views.UserProfileView.as_view(), name='user-profile'),
    path('<str:username>/follow/', views.follow_user, name='follow-user'),
    path('<str:username>/unfollow/', views.unfollow_user, name='unfollow-user'),
]
