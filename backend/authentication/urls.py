from django.urls import path

from .github_connection import GithubAccountsView, GithubConnectionStartView

from .views import (
    GithubOAuthCallbackView,
    GithubOAuthResultView,
    GithubOAuthStartView,
    LoginView,
    LogoutView,
    RegisterView,
    ResetPasswordView,
    SendOTPView,
    SendPasswordResetOTPView,
    SocialLoginView,
    TokenRefreshView,
    UsernameCheckView,
    ValidatePasswordResetOTPView,
    VerifyTokenView,
)

urlpatterns = [
    path('register/', RegisterView.as_view(), name='register'),
    path('login/', LoginView.as_view(), name='login'),
    path('logout/', LogoutView.as_view(), name='logout'),
    path('send-otp/', SendOTPView.as_view(), name='send_otp'),
    path('send-password-reset-otp/', SendPasswordResetOTPView.as_view(), name='send_password_reset_otp'),
    path('validate-password-reset-otp/', ValidatePasswordResetOTPView.as_view(), name='validate_password_reset_otp'),
    path('reset-password/', ResetPasswordView.as_view(), name='reset_password'),
    path('check-username/', UsernameCheckView.as_view(), name='check_username'),
    path('social-login/', SocialLoginView.as_view(), name='social_login'),
    path('verify-token/', VerifyTokenView.as_view(), name='verify_token'),
    path('refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('github/accounts/', GithubAccountsView.as_view(), name='github_accounts'),
    path('github/accounts/<str:uid>/', GithubAccountsView.as_view(), name='github_account_detail'),
    path('github/connect/', GithubConnectionStartView.as_view(), name='github_connection_start'),
    path('github/login/', GithubOAuthStartView.as_view(), name='github_oauth_start'),
    path('github/result/', GithubOAuthResultView.as_view(), name='github_oauth_result'),
    path('github/callback/', GithubOAuthCallbackView.as_view(), name='github_oauth_callback'),
    path('github/callback', GithubOAuthCallbackView.as_view()),
]
