"""Shared persistence, access control and retrieval for memories and notes."""
import logging
import math
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.db.models import Case, FloatField, Func, IntegerField, Q, When
from django.utils import timezone
from pgvector.django import CosineDistance

from chat.models import MEMORY_CATEGORIES, AgentNote, Memory
from chat.services.search_text import candidate_patterns, fold, matched_terms, search_terms
from chat.services.utils import embedding_model_name, get_vector_cached

logger = logging.getLogger(__name__)

class StoreError(Exception):
    def __init__(self, message, status=400, matches=None):
        super().__init__(message)
        self.status = status
        self.matches = matches

    def as_dict(self):
        data = {"error": str(self)}
        if self.matches is not None:
            data["matches"] = self.matches
        return data


def text(value, field, *, required=False, max_length=None):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise StoreError(f"{field} must be a string")
    value = value.strip()
    if required and not value:
        raise StoreError(f"{field} is required")
    if max_length and len(value) > max_length:
        raise StoreError(f"{field} exceeds {max_length} characters")
    return value


def identifier(value, field="uuid"):
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise StoreError(f"Invalid {field}") from None


def serialize(record):
    data = {
        "uuid": str(record.uuid), "content": record.content,
        "category": record.category, "importance_score": record.importance_score,
        "created_at": record.created_at.isoformat(), "updated_at": record.updated_at.isoformat(),
        "last_accessed_at": record.last_accessed_at.isoformat() if record.last_accessed_at else None,
    }
    if isinstance(record, Memory):
        data["label"] = record.label
    else:
        data["sandbox_uuid"] = str(record.sandbox_id) if record.sandbox_id else None
        data["workspace_uuid"] = str(record.workspace_id) if record.workspace_id else None
    if hasattr(record, "distance"):
        data["distance"] = round(float(record.distance), 4)
    return data


def memory_available(user, conversation=None):
    # Refresh the preference: an already running worker must respect opt-out.
    if not get_user_model().objects.filter(pk=user.pk, memory_enabled=True).exists():
        return False
    if conversation:
        workspace_id = conversation.workspace_id
        if not workspace_id:
            from sandbox.services.sandbox_service import SandboxBootstrapService
            project = SandboxBootstrapService.conversation_project(conversation)
            workspace_id = project.workspace_id if project else None
        if workspace_id:
            from sandbox.models import Workspace
            # Personal facts never enter a team conversation.
            return Workspace.objects.filter(pk=workspace_id, owner=user).exists() and not (
                Workspace.objects.get(pk=workspace_id).memberships.exclude(user=user).exists()
            )
    return True


def refresh_embedding(record):
    try:
        vector = get_vector_cached(record.content, str(record.user_id))
        if not vector or not all(math.isfinite(float(v)) for v in vector):
            return
        # A slower worker cannot overwrite an embedding for newer content.
        with transaction.atomic():
            type(record).objects.filter(pk=record.pk, content=record.content, vector__isnull=True).update(
                vector=vector, embedding_model=embedding_model_name(),
            )
    except Exception:
        logger.warning("Embedding generation failed for %s %s", type(record).__name__, record.pk)


class StoreService:
    model = None

    def __init__(self, user, *, conversation=None, management=False, sandbox_uuid=None, workspace_uuid=None):
        self.user = user
        self.conversation = conversation
        self.management = management
        self.sandbox = None
        self.workspace = None

    def queryset(self):
        raise NotImplementedError

    def values(self, data, *, creating=False):
        values = {}
        if creating or "content" in data:
            values["content"] = text(data.get("content"), "content", required=True, max_length=8000)
        if creating or "category" in data:
            category = text(data.get("category"), "category", max_length=20 if self.model is Memory else 30) or None
            if self.model is Memory:
                category = "workspace" if category == "project" else category
                if category and category not in dict(MEMORY_CATEGORIES):
                    raise StoreError(f"Invalid category: {category}")
            values["category"] = category
        if creating or "importance_score" in data:
            try:
                score = int(data.get("importance_score", 5 if self.model is Memory else 3))
            except (ValueError, TypeError):
                raise StoreError("importance_score must be an integer between 1 and 10") from None
            if not 1 <= score <= 10:
                raise StoreError("importance_score must be between 1 and 10")
            values["importance_score"] = score
        if self.model is Memory and (creating or "label" in data):
            values["label"] = text(data.get("label"), "label", max_length=100) or None
        return values

    def _lock_scope(self):
        scope = self.sandbox or self.workspace or self.user
        type(scope).objects.select_for_update().get(pk=scope.pk)

    def create(self, data, *, source_message=None):
        qs = self.queryset()
        values = self.values(data, creating=True)
        with transaction.atomic():
            self._lock_scope()
            qs = self.queryset()
            record = qs.filter(content__iexact=values["content"]).first()
            created = record is None
            if created:
                extra = {"user": self.user, "source_message": source_message}
                if self.model is AgentNote:
                    extra.update(sandbox=self.sandbox, workspace=self.workspace)
                record = self.model.objects.create(**values, **extra)
        if record.vector is None:
            refresh_embedding(record)
        return record, created

    def find(self, data, *, lock=False):
        qs = self.queryset()
        if lock:
            qs = qs.select_for_update()
        if data.get("uuid"):
            record = qs.filter(pk=identifier(data["uuid"])).first()
        else:
            old = text(data.get("old_text"), "old_text", required=True)
            exact = list(qs.filter(content__iexact=old)[:2])
            matches = exact or list(qs.filter(content__icontains=old)[:21])
            if len(matches) > 1:
                raise StoreError("Multiple records match; use uuid", 409, [serialize(m) for m in matches])
            record = matches[0] if matches else None
        if record is None:
            raise StoreError("Record not found", 404)
        return record

    def update(self, data, *, source_message=None, expected_updated_at=None):
        values = self.values(data)
        with transaction.atomic():
            self._lock_scope()
            record = self.find(data, lock=True)
            if expected_updated_at is not None and record.updated_at != expected_updated_at:
                raise StoreError("Record changed during extraction", 409)
            changed = "content" in values and values["content"] != record.content
            if changed and self.queryset().filter(content__iexact=values["content"]).exclude(pk=record.pk).exists():
                raise StoreError("A record with this content already exists", 409)
            for field, value in values.items():
                setattr(record, field, value)
            fields = list(values) + ["updated_at"]
            if changed:
                record.vector = None
                record.embedding_model = ""
                fields += ["vector", "embedding_model"]
            if source_message:
                record.source_message = source_message
                fields.append("source_message")
            record.save(update_fields=fields)
        if changed:
            refresh_embedding(record)
        return record

    def remove(self, data):
        with transaction.atomic():
            record = self.find(data, lock=True)
            record_uuid = str(record.uuid)
            record.delete()
        return record_uuid

    def list(self, data):
        qs = self.queryset()
        if data.get("category"):
            category = text(data["category"], "category")
            qs = qs.filter(category="workspace" if self.model is Memory and category == "project" else category)
        if self.model is Memory and data.get("label"):
            qs = qs.filter(label__iexact=text(data["label"], "label"))
        return qs.order_by("-updated_at", "uuid")

    def search(self, data, *, semantic=True, min_matches=1, touch=True):
        """Hybrid search. Lexical-only hits need ``min_matches`` distinct query terms
        (an exact phrase hit always qualifies); ``touch`` records the access."""
        qs = self.queryset()
        query = text(data.get("query"), "query", required=True, max_length=8000)
        try:
            limit = min(20, max(1, int(data.get("limit", 5))))
        except (ValueError, TypeError):
            raise StoreError("limit must be an integer") from None
        vector = []
        if semantic and connection.vendor == "postgresql":
            try:
                vector = get_vector_cached(query, str(self.user.pk))
            except Exception:
                logger.warning("Query embedding unavailable; using text search")
        candidates = {}
        if vector:
            try:
                # CASE guards mixed dimensions even if PostgreSQL reorders filters.
                semantic = qs.filter(vector__isnull=False, embedding_model=embedding_model_name()).annotate(
                    dimensions=Func("vector", function="vector_dims", output_field=IntegerField()),
                ).annotate(distance=Case(
                    When(dimensions=len(vector), then=CosineDistance("vector", vector)),
                    default=None, output_field=FloatField(),
                )).filter(distance__lte=0.7).order_by("distance")[:40]
                # Keep a SQL error from poisoning an enclosing request transaction.
                with transaction.atomic():
                    records = list(semantic)
                candidates.update((r.pk, r) for r in records)
            except Exception:
                logger.warning("Semantic search failed; using text search")
        terms = search_terms(query)
        phrase = " ".join(fold(query).split())
        lexical = Q(pk__in=[])
        for pattern in candidate_patterns(terms):
            lexical |= Q(content__iregex=pattern)
        for record in qs.filter(lexical).order_by("-importance_score", "-updated_at")[:100]:
            matched = matched_terms(record.content, terms)
            exact = len(phrase) >= 8 and phrase in " ".join(fold(record.content).split())
            if not exact and matched < max(1, min_matches):
                continue
            record = candidates.setdefault(record.pk, record)
            # Coverage of up to three distinct terms; an exact phrase is a full hit.
            record.lexical_relevance = 1.0 if exact else 0.9 * min(1.0, matched / min(len(terms), 3))
        now = timezone.now()
        def rank(record):
            relevance = max(1 - getattr(record, "distance", 1), getattr(record, "lexical_relevance", 0))
            age_days = max(0, (now - record.updated_at).total_seconds() / 86400)
            score = relevance * 0.7 + record.importance_score / 10 * 0.15 + 0.15 / (1 + age_days / 30)
            return (-score, str(record.pk))
        results = sorted(candidates.values(), key=rank)[:limit]
        if touch and results:
            self.queryset().filter(pk__in=[r.pk for r in results]).update(last_accessed_at=now)
        return results


class MemoryService(StoreService):
    model = Memory

    def queryset(self):
        if not self.management and not memory_available(self.user, self.conversation):
            raise StoreError("Personal memory is disabled or unavailable in this conversation", 403)
        return Memory.objects.filter(user=self.user)


class NoteService(StoreService):
    model = AgentNote

    def __init__(self, user, *, conversation=None, management=False, sandbox_uuid=None, workspace_uuid=None):
        super().__init__(user, conversation=conversation, management=management)
        from sandbox.models import Sandbox, Workspace
        self.personal_scope = False
        if conversation:
            from sandbox.services.sandbox_service import SandboxBootstrapService
            self.sandbox = SandboxBootstrapService.conversation_project(conversation)
            workspace_uuid = conversation.workspace_id
            sandbox_uuid = self.sandbox.pk if self.sandbox else None
        if sandbox_uuid:
            self.sandbox = Sandbox.objects.filter(pk=identifier(sandbox_uuid, "sandbox_uuid")).first()
            if self.sandbox is None:
                raise StoreError("Project not found", 404)
            if workspace_uuid and str(self.sandbox.workspace_id) != str(workspace_uuid):
                raise StoreError("Project belongs to another workspace", 403)
            workspace_uuid = self.sandbox.workspace_id
            if not workspace_uuid and self.sandbox.user_id != user.pk:
                raise StoreError("Project not found", 404)
        if workspace_uuid:
            self.workspace = Workspace.objects.filter(pk=identifier(workspace_uuid, "workspace_uuid")).filter(
                Q(owner=user) | Q(memberships__user=user),
            ).distinct().first()
            if self.workspace is None:
                raise StoreError("Workspace not found", 404)
        elif self.sandbox is None:
            # Legacy callers without routing use a private workspace, never a team.
            self.workspace = Workspace.objects.filter(owner=user).exclude(
                memberships__user__in=get_user_model().objects.exclude(pk=user.pk),
            ).order_by('created_at').first()
            if self.workspace is None:
                raise StoreError("workspace_uuid is required")
            self.personal_scope = True

    def queryset(self):
        if self.workspace:
            from sandbox.models import Workspace
            if not Workspace.objects.filter(pk=self.workspace.pk).filter(Q(owner=self.user) | Q(memberships__user=self.user)).exists():
                raise StoreError("Workspace access revoked", 403)
            if self.personal_scope and self.workspace.memberships.exclude(user=self.user).exists():
                raise StoreError("workspace_uuid is required for a team workspace")
        if self.sandbox:
            return AgentNote.objects.filter(sandbox=self.sandbox)
        if self.workspace:
            if self.personal_scope:
                return AgentNote.objects.filter(sandbox__isnull=True).filter(
                    Q(workspace=self.workspace) | Q(user=self.user, workspace__isnull=True),
                )
            return AgentNote.objects.filter(workspace=self.workspace, sandbox__isnull=True)
        return AgentNote.objects.filter(user=self.user, workspace__isnull=True, sandbox__isnull=True)
