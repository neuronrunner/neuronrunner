"""Native, environment-scoped issues that users and agents can create and work on."""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class Issue(models.Model):
    STATUS_TODO = "todo"
    STATUS_IN_PROGRESS = "in_progress"
    STATUS_IN_REVIEW = "in_review"
    STATUS_DONE = "done"
    STATUS_CANCELLED = "cancelled"
    STATUS_CHOICES = [
        (STATUS_TODO, "To do"),
        (STATUS_IN_PROGRESS, "In progress"),
        (STATUS_IN_REVIEW, "In review"),
        (STATUS_DONE, "Done"),
        (STATUS_CANCELLED, "Cancelled"),
    ]
    OPEN_STATUSES = (STATUS_TODO, STATUS_IN_PROGRESS, STATUS_IN_REVIEW)
    CLOSED_STATUSES = (STATUS_DONE, STATUS_CANCELLED)

    PRIORITY_NONE = "none"
    PRIORITY_LOW = "low"
    PRIORITY_MEDIUM = "medium"
    PRIORITY_HIGH = "high"
    PRIORITY_URGENT = "urgent"
    PRIORITY_CHOICES = [
        (PRIORITY_NONE, "None"),
        (PRIORITY_LOW, "Low"),
        (PRIORITY_MEDIUM, "Medium"),
        (PRIORITY_HIGH, "High"),
        (PRIORITY_URGENT, "Urgent"),
    ]

    CREATOR_USER = "user"
    CREATOR_AGENT = "agent"
    CREATOR_IMPORT = "import"
    CREATOR_CHOICES = [
        (CREATOR_USER, "User"),
        (CREATOR_AGENT, "Agent"),
        (CREATOR_IMPORT, "Import"),
    ]

    SOURCE_GITHUB = "github"
    SOURCE_GITLAB = "gitlab"

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sandbox = models.ForeignKey(
        "sandbox_app.Sandbox", on_delete=models.CASCADE, related_name="issues"
    )
    number = models.PositiveIntegerField()
    title = models.CharField(max_length=300)
    body = models.TextField(blank=True, default="")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_TODO)
    priority = models.CharField(max_length=10, choices=PRIORITY_CHOICES, default=PRIORITY_NONE)
    labels = models.JSONField(default=list, blank=True)

    creator_type = models.CharField(max_length=10, choices=CREATOR_CHOICES, default=CREATOR_USER)
    creator_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_issues",
    )
    source_conversation = models.ForeignKey(
        "chat.Conversation",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_issues",
    )

    assignee_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_issues",
    )
    assigned_to_agent = models.BooleanField(default=False)
    agent_conversation = models.ForeignKey(
        "chat.Conversation",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="agent_issues",
    )

    branch = models.CharField(max_length=255, blank=True, default="")
    pr_url = models.URLField(max_length=500, blank=True, default="")
    pr_number = models.PositiveIntegerField(null=True, blank=True)

    external_source = models.CharField(max_length=10, blank=True, default="")
    external_id = models.CharField(max_length=64, blank=True, default="")
    external_url = models.URLField(max_length=500, blank=True, default="")
    external_author = models.CharField(max_length=150, blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(fields=["sandbox", "number"], name="issue_unique_number_per_sandbox"),
            models.UniqueConstraint(
                fields=["sandbox", "external_source", "external_id"],
                condition=~Q(external_source=""),
                name="issue_unique_external_per_sandbox",
            ),
        ]
        indexes = [
            models.Index(fields=["sandbox", "status", "-updated_at"]),
        ]

    def __str__(self):
        return f"#{self.number} {self.title}"

    @property
    def is_open(self) -> bool:
        return self.status in self.OPEN_STATUSES


class IssueComment(models.Model):
    AUTHOR_USER = "user"
    AUTHOR_AGENT = "agent"
    AUTHOR_SYSTEM = "system"
    AUTHOR_IMPORT = "import"
    AUTHOR_CHOICES = [
        (AUTHOR_USER, "User"),
        (AUTHOR_AGENT, "Agent"),
        (AUTHOR_SYSTEM, "System"),
        (AUTHOR_IMPORT, "Import"),
    ]

    uuid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="comments")
    author_type = models.CharField(max_length=10, choices=AUTHOR_CHOICES, default=AUTHOR_USER)
    author_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="issue_comments",
    )
    author_name = models.CharField(max_length=150, blank=True, default="")
    body = models.TextField()
    conversation = models.ForeignKey(
        "chat.Conversation",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="issue_comments",
    )
    external_id = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return f"Comment on #{self.issue.number} by {self.author_name or self.author_type}"
