"""URL Configuration for sandbox."""
from django.urls import path

from .custom_model_views import TestCustomModelView, WorkspaceCustomModelsView
from .preview_views import SandboxPortPreviewView
from .provider_key_views import (
    WorkspaceLLMSetupView,
    WorkspaceProviderKeySyncFromVMView,
    WorkspaceProviderKeysView,
    WorkspaceProviderRefreshModelsView,
    WorkspaceProviderRemoteModelsView,
    WorkspaceProviderVMLoginPrepareView,
)
from .runtime_views import WorkspaceRuntimeDetailView, WorkspaceRuntimesView
from .repository_views import (
    RepositoryDiffView,
    RepositoryHistoryView,
    RepositoryIssueCommentsView,
    RepositoryIssueDetailView,
    RepositoryIssuesView,
    RepositoryPullRequestChecksView,
    RepositoryPullRequestCommentsView,
    RepositoryPullRequestCommitsView,
    RepositoryPullRequestDetailView,
    RepositoryPullRequestFilesView,
    RepositoryPullRequestsView,
    RepositoryPushView,
    RepositoryReadView,
    RepositoryStageView,
    RepositoryStatusView,
    RepositorySwitchView,
    RepositoryUnstageView,
    RepositoryWriteView,
)
from .views import (
    ModelGPUOptionsView,
    ModelRuntimeCatalogView,
    ModelRuntimeDetailView,
    SandboxAgentToolsView,
    SandboxDetailView,
    SandboxEventsView,
    SandboxFileContentView,
    SandboxFileDetailView,
    SandboxFileListCreateView,
    SandboxFileUploadView,
    SandboxGitCloneCommandView,
    SandboxGitCloneView,
    SandboxGitDiffView,
    SandboxGitInitView,
    SandboxGitStatusView,
    SandboxGitUndoView,
    SandboxGithubReposView,
    SandboxImagePreviewView,
    SandboxListCreateView,
    SandboxPingView,
    SandboxStartView,
    SandboxSuggestionsView,
    SandboxTerminalTicketView,
    WorkspaceDetailView,
    WorkspaceInvitationAcceptView,
    WorkspaceInvitationDetailView,
    WorkspaceListCreateView,
    WorkspaceMemberDetailView,
    WorkspaceMembersView,
)
from .vm_secret_views import (
    WorkspaceVMSecretBulkImportView,
    WorkspaceVMSecretDetailView,
    WorkspaceVMSecretsView,
)

urlpatterns = [
    path("workspaces/<uuid:workspace_uuid>/provider-keys/", WorkspaceProviderKeysView.as_view(), name="workspace-provider-keys"),
    path("workspaces/<uuid:workspace_uuid>/provider-keys/sync-from-vm/", WorkspaceProviderKeySyncFromVMView.as_view(), name="workspace-provider-keys-sync-vm"),
    path("workspaces/<uuid:workspace_uuid>/provider-keys/vm-login/", WorkspaceProviderVMLoginPrepareView.as_view(), name="workspace-provider-keys-vm-login"),
    path("workspaces/<uuid:workspace_uuid>/provider-keys/refresh-models/", WorkspaceProviderRefreshModelsView.as_view(), name="workspace-provider-keys-refresh-models"),
    path("workspaces/<uuid:workspace_uuid>/provider-keys/remote-models/", WorkspaceProviderRemoteModelsView.as_view(), name="workspace-provider-keys-remote-models"),
    path("workspaces/<uuid:workspace_uuid>/llm-setup/", WorkspaceLLMSetupView.as_view(), name="workspace-llm-setup"),
    path("workspaces/<uuid:workspace_uuid>/vm-secrets/", WorkspaceVMSecretsView.as_view(), name="workspace-vm-secrets"),
    path("workspaces/<uuid:workspace_uuid>/vm-secrets/bulk-import/", WorkspaceVMSecretBulkImportView.as_view(), name="workspace-vm-secrets-bulk-import"),
    path("workspaces/<uuid:workspace_uuid>/vm-secrets/<uuid:secret_uuid>/", WorkspaceVMSecretDetailView.as_view(), name="workspace-vm-secret-detail"),
    path("workspaces/<uuid:workspace_uuid>/runtimes/", WorkspaceRuntimesView.as_view(), name="workspace-runtimes"),
    path("workspaces/<uuid:workspace_uuid>/runtimes/<str:runtime_name>/", WorkspaceRuntimeDetailView.as_view(), name="workspace-runtime-detail"),
    path("workspaces/<uuid:workspace_uuid>/runtimes/<str:runtime_name>/stop/", WorkspaceRuntimeDetailView.as_view(), name="workspace-runtime-stop"),
    path("workspaces/<uuid:workspace_uuid>/custom-models/", WorkspaceCustomModelsView.as_view(), name="workspace-custom-models"),
    path("workspaces/<uuid:workspace_uuid>/custom-models/test/", TestCustomModelView.as_view(), name="workspace-custom-models-test"),
    path("workspaces/<uuid:workspace_uuid>/custom-models/<str:model_name>/", WorkspaceCustomModelsView.as_view(), name="workspace-custom-model-detail"),

    # Team workspaces and memberships
    path("workspaces/", WorkspaceListCreateView.as_view(), name="workspace-list-create"),
    path("workspaces/<uuid:workspace_uuid>/", WorkspaceDetailView.as_view(), name="workspace-detail"),
    path("workspaces/<uuid:workspace_uuid>/members/", WorkspaceMembersView.as_view(), name="workspace-members"),
    path("workspaces/<uuid:workspace_uuid>/members/<uuid:user_uuid>/", WorkspaceMemberDetailView.as_view(), name="workspace-member-detail"),
    path("workspaces/<uuid:workspace_uuid>/invitations/<uuid:invitation_uuid>/", WorkspaceInvitationDetailView.as_view(), name="workspace-invitation-detail"),
    path("workspace-invitations/<uuid:token>/accept/", WorkspaceInvitationAcceptView.as_view(), name="workspace-invitation-accept"),

    # Sandboxes (CRUD)
    path("sandboxes/", SandboxListCreateView.as_view(), name="sandbox-sandboxes-list"),
    path("sandboxes/<str:lookup>/", SandboxDetailView.as_view(), name="sandbox-sandbox-detail"),
    path("sandboxes/<uuid:sandbox_uuid>/start/", SandboxStartView.as_view(), name="sandbox-sandbox-start"),
    path("sandboxes/<uuid:sandbox_uuid>/suggestions/", SandboxSuggestionsView.as_view(), name="sandbox-suggestions"),
    path("sandboxes/<uuid:sandbox_uuid>/ping/", SandboxPingView.as_view(), name="sandbox-sandbox-ping"),

    path("sandboxes/<uuid:sandbox_uuid>/terminal-ticket/", SandboxTerminalTicketView.as_view(), name="sandbox-terminal-ticket"),
    path("sandboxes/<uuid:sandbox_uuid>/port-preview/", SandboxPortPreviewView.as_view(), name="sandbox-port-preview"),

    # Sandbox files & Git / GitHub Studio
    path("sandboxes/<uuid:sandbox_uuid>/files/", SandboxFileListCreateView.as_view(), name="sandbox-sandbox-files"),
    path("sandboxes/<uuid:sandbox_uuid>/files/upload/", SandboxFileUploadView.as_view(), name="sandbox-sandbox-file-upload"),
    path("sandboxes/<uuid:sandbox_uuid>/files/<str:file_id>/", SandboxFileDetailView.as_view(), name="sandbox-sandbox-file-detail"),
    path("sandboxes/<uuid:sandbox_uuid>/git-clone/", SandboxGitCloneView.as_view(), name="sandbox-git-clone"),
    path("sandboxes/<uuid:sandbox_uuid>/git-clone-command/", SandboxGitCloneCommandView.as_view(), name="sandbox-git-clone-command"),
    path("sandboxes/<uuid:sandbox_uuid>/git/status/", SandboxGitStatusView.as_view(), name="sandbox-git-status"),
    path("sandboxes/<uuid:sandbox_uuid>/git/repositories/", RepositoryReadView.as_view(), name="workspace-git-repositories"),
    path("sandboxes/<uuid:sandbox_uuid>/git/repository/", RepositoryStatusView.as_view(), name="workspace-git-repository"),
    path("sandboxes/<uuid:sandbox_uuid>/git/history/", RepositoryHistoryView.as_view(), name="workspace-git-history"),
    path("sandboxes/<uuid:sandbox_uuid>/git/commit/", RepositoryWriteView.as_view(), name="workspace-git-commit"),
    path("sandboxes/<uuid:sandbox_uuid>/git/switch/", RepositorySwitchView.as_view(), name="workspace-git-switch"),
    path("sandboxes/<uuid:sandbox_uuid>/git/push/", RepositoryPushView.as_view(), name="workspace-git-push"),
    path("sandboxes/<uuid:sandbox_uuid>/git/stage/", RepositoryStageView.as_view(), name="workspace-git-stage"),
    path("sandboxes/<uuid:sandbox_uuid>/git/unstage/", RepositoryUnstageView.as_view(), name="workspace-git-unstage"),
    path("sandboxes/<uuid:sandbox_uuid>/git/file-diff/", RepositoryDiffView.as_view(), name="workspace-git-file-diff"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/", RepositoryPullRequestsView.as_view(), name="workspace-pull-requests"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/<int:pull_number>/", RepositoryPullRequestDetailView.as_view(), name="workspace-pull-request-detail"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/detail/", RepositoryPullRequestDetailView.as_view(), name="workspace-pull-request-detail-query"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/<int:pull_number>/files/", RepositoryPullRequestFilesView.as_view(), name="workspace-pull-request-files"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/files/", RepositoryPullRequestFilesView.as_view(), name="workspace-pull-request-files-query"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/<int:pull_number>/commits/", RepositoryPullRequestCommitsView.as_view(), name="workspace-pull-request-commits"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/commits/", RepositoryPullRequestCommitsView.as_view(), name="workspace-pull-request-commits-query"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/<int:pull_number>/comments/", RepositoryPullRequestCommentsView.as_view(), name="workspace-pull-request-comments"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/comments/", RepositoryPullRequestCommentsView.as_view(), name="workspace-pull-request-comments-query"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/<int:pull_number>/checks/", RepositoryPullRequestChecksView.as_view(), name="workspace-pull-request-checks"),
    path("sandboxes/<uuid:sandbox_uuid>/github/pull-requests/checks/", RepositoryPullRequestChecksView.as_view(), name="workspace-pull-request-checks-query"),
    path("sandboxes/<uuid:sandbox_uuid>/github/issues/", RepositoryIssuesView.as_view(), name="workspace-issues"),
    path("sandboxes/<uuid:sandbox_uuid>/github/issues/<int:issue_number>/", RepositoryIssueDetailView.as_view(), name="workspace-issue-detail"),
    path("sandboxes/<uuid:sandbox_uuid>/github/issues/detail/", RepositoryIssueDetailView.as_view(), name="workspace-issue-detail-query"),
    path("sandboxes/<uuid:sandbox_uuid>/github/issues/<int:issue_number>/comments/", RepositoryIssueCommentsView.as_view(), name="workspace-issue-comments"),
    path("sandboxes/<uuid:sandbox_uuid>/github/issues/comments/", RepositoryIssueCommentsView.as_view(), name="workspace-issue-comments-query"),
    path("sandboxes/<uuid:sandbox_uuid>/git/diff/", SandboxGitDiffView.as_view(), name="sandbox-git-diff"),
    path("sandboxes/<uuid:sandbox_uuid>/git/undo/", SandboxGitUndoView.as_view(), name="sandbox-git-undo"),
    path("sandboxes/<uuid:sandbox_uuid>/git/init/", SandboxGitInitView.as_view(), name="sandbox-git-init"),
    path("github/repos/", SandboxGithubReposView.as_view(), name="user-github-repos"),
    path("sandboxes/<uuid:sandbox_uuid>/github/repos/", SandboxGithubReposView.as_view(), name="sandbox-github-repos"),

    # File content & image preview
    path("sandboxes/<uuid:sandbox_uuid>/files/<str:file_id>/content/", SandboxFileContentView.as_view(), name="sandbox-file-content"),
    path("sandboxes/<uuid:sandbox_uuid>/image-preview/", SandboxImagePreviewView.as_view(), name="sandbox-image-preview"),

    # Sandbox events
    path("sandboxes/<uuid:sandbox_uuid>/events/", SandboxEventsView.as_view(), name="sandbox-sandbox-events"),

    # GPU options & agent tools
    path("gpu-options/", ModelGPUOptionsView.as_view(), name="sandbox-gpu-options"),
    path("sandbox-tools/list/", SandboxAgentToolsView.as_view(), name="sandbox-tools-list"),

    # Model catalog
    path("models/", ModelRuntimeCatalogView.as_view(), name="sandbox-model-catalog"),
    path("models/<slug:slug>/", ModelRuntimeDetailView.as_view(), name="sandbox-model-detail"),
]

from core.extensions import expand_urlpatterns, registry as _ext_registry
urlpatterns = [*expand_urlpatterns(_ext_registry.app.extra_sandbox_urlpatterns), *urlpatterns]
