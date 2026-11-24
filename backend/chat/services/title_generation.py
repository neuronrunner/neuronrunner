"""Generate conversation titles independently of the assistant's tool loop."""
from chat.models import Conversation

PLACEHOLDER_TITLES = {"", "Untitled Conversation", "Conversation", "New Conversation", "New conversation", "New Chat"}


def title_generation_available(conversation):
    return (
        (conversation.title or "").strip() in PLACEHOLDER_TITLES
        and not conversation.messages.filter(role="assistant").exists()
        and conversation.messages.filter(role="user").count() <= 1
    )


def save_generated_title(conversation, raw, *, original_title):
    if not isinstance(raw, str):
        return None
    title = " ".join(raw.split()).strip("\"'").strip()
    if not title or len(title) > 80 or title in PLACEHOLDER_TITLES:
        return None
    # Compare against the initial value atomically: a manual rename or another
    # generation that finished first must win, even after the assistant is saved.
    updated = Conversation.objects.filter(
        pk=conversation.pk, user_id=conversation.user_id, title=original_title,
    ).update(title=title)
    return title if updated else None
