from django.urls import path

from .views import (
    EnvironmentIssuesView,
    IssueAssignAgentView,
    IssueCommentsView,
    IssueDetailView,
    IssueImportView,
    IssueUnassignAgentView,
)

urlpatterns = [
    path("environments/<uuid:sandbox_uuid>/", EnvironmentIssuesView.as_view(), name="issues-list"),
    path("environments/<uuid:sandbox_uuid>/import/", IssueImportView.as_view(), name="issues-import"),
    path("environments/<uuid:sandbox_uuid>/<int:number>/", IssueDetailView.as_view(), name="issue-detail"),
    path(
        "environments/<uuid:sandbox_uuid>/<int:number>/comments/",
        IssueCommentsView.as_view(),
        name="issue-comments",
    ),
    path(
        "environments/<uuid:sandbox_uuid>/<int:number>/assign-agent/",
        IssueAssignAgentView.as_view(),
        name="issue-assign-agent",
    ),
    path(
        "environments/<uuid:sandbox_uuid>/<int:number>/unassign-agent/",
        IssueUnassignAgentView.as_view(),
        name="issue-unassign-agent",
    ),
]
