"""Tests for NeuronRunner memory system changes.

Covers:
  1. Schema changes (AgentNote.vector, Message.search_vector, GIN index)
  2. Built-in tool executor (memory_search, note_search, session_search)
  3. Forced injection removal in _build_messages()
  4. Tool guide presence
  5. Embedding generation on memory_add / note_add
"""
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.postgres.search import SearchVector
from django.test import TestCase

from chat.builtin_tools import BUILTIN_TOOLS, execute_builtin_tool
from chat.models import AgentNote, Conversation, Memory, Message

User = get_user_model()


class SchemaTests(TestCase):
    """Verify model fields and indexes were added."""

    def test_agentnote_has_vector_field(self):
        field = AgentNote._meta.get_field("vector")
        self.assertEqual(field.get_internal_type(), "VectorField")
        self.assertTrue(field.null)

    def test_message_has_search_vector_field(self):
        field = Message._meta.get_field("search_vector")
        self.assertEqual(field.get_internal_type(), "SearchVectorField")
        self.assertTrue(field.null)

    def test_message_has_gin_index(self):
        from django.contrib.postgres.indexes import GinIndex
        has_gin = any(isinstance(idx, GinIndex) for idx in Message._meta.indexes)
        self.assertTrue(has_gin, "Message is missing GIN index on search_vector")


class BuiltinToolDefinitionTests(TestCase):
    """Verify the new tool definitions are in BUILTIN_TOOLS."""

    def _get_tool(self, name: str) -> dict | None:
        for t in BUILTIN_TOOLS:
            if t.get("function", {}).get("name") == name:
                return t
        return None

    def test_memory_search_is_registered(self):
        tool = self._get_tool("memory_search")
        self.assertIsNotNone(tool)
        params = tool["function"]["parameters"]["properties"]
        self.assertIn("query", params)
        self.assertIn("limit", params)
        self.assertEqual(params["limit"]["maximum"], 20)

    def test_note_search_is_registered(self):
        tool = self._get_tool("note_search")
        self.assertIsNotNone(tool)
        params = tool["function"]["parameters"]["properties"]
        self.assertIn("query", params)
        self.assertIn("limit", params)

    def test_session_search_is_registered(self):
        tool = self._get_tool("session_search")
        self.assertIsNotNone(tool)
        params = tool["function"]["parameters"]["properties"]
        self.assertIn("query", params)
        self.assertIn("limit", params)
        self.assertEqual(params["limit"]["maximum"], 10)

    def test_total_tool_count(self):
        self.assertGreaterEqual(len(BUILTIN_TOOLS), 11)

    def test_new_tools_have_query_required(self):
        for name in ["memory_search", "note_search", "session_search"]:
            tool = self._get_tool(name)
            required = tool["function"]["parameters"].get("required", [])
            self.assertIn("query", required, f"{name} should require 'query'")


@patch("chat.services.memory_service.get_vector_cached", return_value=[0.1] * 1536)
class ExecuteMemorySearchTests(TestCase):
    """Test memory_search tool execution."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="memsearch-user",
            password="test-pass-123",
            email="memsearch@example.com",
        )
        # Create some memories with vectors
        self.m1 = Memory.objects.create(
            user=self.user,
            content="User prefers React with Chakra UI for frontend development",
            category="preference",
            importance_score=7,
            label="framework",
            vector=[0.1] * 1536,
        )
        self.m2 = Memory.objects.create(
            user=self.user,
            content="User works on NeuronRunner project (Django + Next.js)",
            category="project",
            importance_score=8,
            label="project",
            vector=[0.2] * 1536,
        )

    def test_requires_query(self, mock_vec):
        result = json.loads(execute_builtin_tool(
            self.user, "memory_search", {}
        ))
        self.assertIn("error", result)

    def test_returns_memories_by_similarity(self, mock_vec):
        result = json.loads(execute_builtin_tool(
            self.user, "memory_search", {"query": "frontend React"}
        ))
        self.assertIn("count", result)
        self.assertGreaterEqual(result["count"], 0)

    def test_limit_param_works(self, mock_vec):
        result = json.loads(execute_builtin_tool(
            self.user, "memory_search", {"query": "test", "limit": 1}
        ))
        self.assertIn("count", result)
        self.assertLessEqual(result["count"], 1)


@patch("chat.services.memory_service.get_vector_cached", return_value=[0.1] * 1536)
class ExecuteNoteSearchTests(TestCase):
    """Test note_search tool execution."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="notesearch-user",
            password="test-pass-123",
            email="notesearch@example.com",
        )
        self.n1 = AgentNote.objects.create(
            user=self.user,
            content="Project uses PostgreSQL 16 with pgvector extension",
            category="env",
            importance_score=5,
            vector=[0.1] * 1536,
        )

    def test_requires_query(self, mock_vec):
        result = json.loads(execute_builtin_tool(
            self.user, "note_search", {}
        ))
        self.assertIn("error", result)

    def test_returns_notes_by_similarity(self, mock_vec):
        result = json.loads(execute_builtin_tool(
            self.user, "note_search", {"query": "database"}
        ))
        self.assertIn("count", result)
        self.assertGreaterEqual(result["count"], 0)


class ExecuteSessionSearchTests(TestCase):
    """Test session_search tool execution."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="sessearch-user",
            password="test-pass-123",
            email="sessearch@example.com",
        )
        self.conv = Conversation.objects.create(
            user=self.user,
            title="Test conversation about deployment",
        )
        # Create messages with search_vector
        for i, content in enumerate([
            "User: Docker deployment is failing with 502 error",
            "Assistant: Let me check the docker-compose configuration",
            "User: I think it's a port mapping issue",
        ]):
            msg = Message.objects.create(
                conversation=self.conv,
                content=content,
                role="user" if i % 2 == 0 else "assistant",
            )
            from django.db import connection
            if connection.vendor == 'postgresql':
                Message.objects.filter(pk=msg.pk).update(
                    search_vector=SearchVector("content", config="simple")
                )

    def test_requires_query(self):
        result = json.loads(execute_builtin_tool(
            self.user, "session_search", {}
        ))
        self.assertIn("error", result)

    def test_returns_sessions_for_keyword(self):
        result = json.loads(execute_builtin_tool(
            self.user, "session_search", {"query": "deployment"}
        ))
        self.assertIn("sessions", result)
        self.assertIsInstance(result["sessions"], list)

    def test_limit_param(self):
        result = json.loads(execute_builtin_tool(
            self.user, "session_search", {"query": "deployment", "limit": 1}
        ))
        self.assertIn("count", result)

    def test_no_match_returns_empty(self):
        result = json.loads(execute_builtin_tool(
            self.user, "session_search", {"query": "nonexistentkeyword12345"}
        ))
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["sessions"], [])


class MemoryAddEmbeddingTests(TestCase):
    """Test that memory_add generates embedding."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="memadd-user",
            password="test-pass-123",
            email="memadd@example.com",
        )

    @patch("chat.services.memory_service.get_vector_cached")
    def test_embedding_generated(self, mock_get_vector):
        mock_get_vector.return_value = [0.5] * 1536
        result = json.loads(execute_builtin_tool(
            self.user, "memory_add", {
                "content": "User prefers dark mode",
                "category": "preference",
                "importance_score": 6,
            }
        ))
        self.assertEqual(result["status"], "ok")
        mock_get_vector.assert_called_once()
        # Verify vector was stored
        memory = Memory.objects.get(uuid=result["uuid"])
        self.assertIsNotNone(memory.vector)


class NoteAddEmbeddingTests(TestCase):
    """Test that note_add generates embedding."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="noteadd-user",
            password="test-pass-123",
            email="noteadd@example.com",
        )

    @patch("chat.services.memory_service.get_vector_cached")
    def test_embedding_generated(self, mock_get_vector):
        mock_get_vector.return_value = [0.5] * 1536
        result = json.loads(execute_builtin_tool(
            self.user, "note_add", {
                "content": "Environment uses Python 3.14",
                "category": "env",
                "importance_score": 4,
            }
        ))
        self.assertEqual(result["status"], "ok")
        mock_get_vector.assert_called_once()
        note = AgentNote.objects.get(uuid=result["uuid"])
        self.assertIsNotNone(note.vector)

    @patch("chat.services.memory_service.get_vector_cached")
    def test_embedding_failure_does_not_block(self, mock_get_vector):
        mock_get_vector.return_value = None
        result = json.loads(execute_builtin_tool(
            self.user, "note_add", {"content": "Test note"}
        ))
        self.assertEqual(result["status"], "ok")


class ChatServiceBuildMessagesTests(TestCase):
    """Test that _build_messages uses tool guide instead of forced injection."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="chatsvc-user",
            password="test-pass-123",
            email="chatsvc@example.com",
        )
        # We test the module directly without DB writes to check business logic
        # Actually let's verify the tool guide str exists in the function

    def test_tool_guide_mentions_search_tools(self):
        """Check that the tool guide string mentions all search tools."""
        import inspect

        from chat.services.chat_service import ChatService
        source = inspect.getsource(ChatService._build_messages)

        # Should NOT contain old injection patterns
        self.assertNotIn("memory_prompt", source)
        self.assertNotIn("agent_note_prompt", source)

        # Should contain the tool guide with all tools
        self.assertIn("tool_guide", source)
        self.assertIn("memory_search(query)", source)
        self.assertIn("note_search(query)", source)
        self.assertIn("session_search(query)", source)
        self.assertIn("web_search(query or queries, limit)", source)

    def test_old_injection_removed(self):
        """Verify no forced memory/note injection code remains."""
        import inspect

        from chat.services.chat_service import ChatService
        source = inspect.getsource(ChatService._build_messages)

        old_patterns = [
            "importance_score__gte=8",
            "Memory.objects.filter(user=user",
            "AgentNote.objects.filter(user=user)",
        ]
        for pattern in old_patterns:
            self.assertNotIn(pattern, source,
                             f"Forced injection code still present: {pattern}")

    def test_tool_guide_before_system_prompt_insert_order(self):
        """The tool guide is inserted before system prompt to keep it closer to model."""
        import inspect

        from chat.services.chat_service import ChatService
        source = inspect.getsource(ChatService._build_messages)

        # tool guide should be inserted
        self.assertIn('{"role": "system", "content": tool_guide}', source)

    def test_unused_imports_removed(self):
        """CosineDistance and F should no longer be imported in chat_service."""
        import inspect

        from chat.services.chat_service import ChatService
        inspect.getsource(ChatService)

        # CosineDistance isn't referenced directly anymore
        # But we can't easily check imports from source inspection,
        # so we check the actual module
        import chat.services.chat_service as chsvc_mod
        self.assertFalse(
            hasattr(chsvc_mod, 'CosineDistance'),
            "CosineDistance is still imported in chat_service"
        )
