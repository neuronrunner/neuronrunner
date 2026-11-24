import json
from types import SimpleNamespace

from django.test import SimpleTestCase

from chat.services.chat_service import ChatService
from chat.services.tool_history import (
    TOOL_RESULT_MAX_CHARS,
    bounded_tool_result,
    bounded_tool_result_text,
    tool_history_text,
)
from chat.services.utils import build_parent_chain


class ToolHistoryTests(SimpleTestCase):
    def test_followup_receives_failed_commands_and_completed_results(self):
        first = SimpleNamespace(role="user", content="Build the app", parent=None)
        reply = SimpleNamespace(role="assistant", content="Done", parent=first, tool_calls=[
            {"function": {"name": "shell_exec", "arguments": '{"command":"pwd"}'}, "result": {"exit_code": 1, "stderr": "Working directory not found: /workspace/demo"}},
            {"function": {"name": "file_write", "arguments": json.dumps({"path": "main.py", "content": "x" * 10000})}, "result": {"path": "main.py", "bytes_written": 10000}},
        ])
        prompt = SimpleNamespace(role="user", content="List tool problems", parent=reply)
        messages = build_parent_chain(prompt)
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "user"])
        self.assertIn("shell_exec [FAILED]", messages[1]["content"])
        self.assertIn("Working directory not found", messages[1]["content"])
        self.assertIn("main.py", messages[1]["content"])
        self.assertNotIn("x" * 1000, messages[1]["content"])
        self.assertEqual(messages[-1]["content"], "List tool problems")

    def test_large_tool_history_prioritizes_errors_without_embedding_image_bytes(self):
        calls = [{"name": "shell_exec", "arguments": {"command": "inspect"}, "result": {"exit_code": 0, "stdout": "x" * 2000}} for _ in range(80)]
        calls[0]["result"] = {"exit_code": -15, "stderr": "killed shell"}
        calls.append({"name": "image_search", "result": {"images": [{"context_url": "data:image/png;base64," + "A" * 10000}]}})
        text = tool_history_text(calls, max_chars=3000)
        self.assertLessEqual(len(text), 3000)
        self.assertIn("killed shell", text)
        self.assertIn("omitted", text)
        self.assertNotIn("A" * 1000, text)

    def test_stream_phases_merge_instead_of_growing_per_chunk(self):
        phases = []
        for chunk in ("a", "b", "c"):
            ChatService._append_stream_phase(phases, "content", chunk, 1)
        self.assertEqual(len(phases), 1)
        self.assertEqual(phases[0]["chunk"], "abc")

        ChatService._append_stream_phase(phases, "thinking", "x", 1)
        self.assertEqual(len(phases), 2)

        ChatService._append_stream_phase(phases, "content", "d", 2)
        self.assertEqual(len(phases), 3)
        self.assertEqual(phases[-1]["chunk"], "d")

    def test_huge_shell_output_is_bounded_before_model_context(self):
        result = {"command": "grep -r continue .", "exit_code": 0, "stdout": "x" * 5_000_000, "stderr": ""}
        text = bounded_tool_result_text(result)
        self.assertLessEqual(len(text), TOOL_RESULT_MAX_CHARS)
        self.assertIn("truncated from", text)
        self.assertIn('"exit_code": 0', text)

    def test_persisted_tool_result_truncates_large_text_fields(self):
        result = {"command": "grep -r continue .", "exit_code": 0, "stdout": "x" * 5_000_000, "stderr": "y" * 5_000_000}
        bounded = bounded_tool_result(result)
        self.assertLess(len(bounded["stdout"]), 25_000)
        self.assertLess(len(bounded["stderr"]), 25_000)
        self.assertEqual(bounded["exit_code"], 0)

    def test_persisted_tool_result_keeps_image_payloads(self):
        image_url = "data:image/png;base64," + "A" * 200_000
        bounded = bounded_tool_result({"images": [{"image_url": image_url}]})
        self.assertEqual(bounded["images"][0]["image_url"], image_url)

    def test_old_images_are_dropped_before_previous_tool_evidence_or_actual_user_prompt(self):
        service = ChatService.__new__(ChatService)
        service.tools = None
        service.max_context_tokens = 7000
        images = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}} for _ in range(16)]
        messages = [{"role": "system", "content": "Instructions"}, {"role": "assistant", "content": "Recorded tool activity: cwd not found"}, {"role": "user", "content": images}, {"role": "user", "content": "List tool problems"}]
        trimmed = service._trim_messages_to_context(messages)
        self.assertIn(messages[1], trimmed)
        self.assertEqual(trimmed[-1]["content"], "List tool problems")
        self.assertLessEqual(sum(service._estimate_message_tokens(m) for m in trimmed), 7000 - 4096)
        self.assertEqual(len(images), 16)
