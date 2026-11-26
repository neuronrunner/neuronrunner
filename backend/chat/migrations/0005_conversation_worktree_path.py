from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0004_conversation_runtime_name"),
    ]

    operations = [
        migrations.AddField(
            model_name="conversation",
            name="worktree_path",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Private Git worktree (under /workspace/.worktrees) this conversation's agent works in; empty means the project folder",
                max_length=120,
            ),
        ),
    ]
