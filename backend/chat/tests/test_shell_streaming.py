import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from sandbox.services.docker_sandbox import LocalDockerProcess
from sandbox.services import file_tools
from sandbox.services.sandbox_session import SandboxSessionManager
from chat.views.openai_completions import _openai_stateful_tool_result_chunk


class ShellStreamingTests(SimpleTestCase):
    def test_partial_stdout_and_stderr_arrive_before_command_finishes(self):
        with TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
            marker = Path(directory) / "finished"
            events = []
            def receive(stream, text):
                if text == "first":
                    self.assertFalse(marker.exists())
                events.append((stream, text))
            command = "printf first; sleep 0.5; printf second; printf problem >&2; touch finished"
            result = file_tools.shell_exec(command, timeout=3, on_output=receive)
            self.assertEqual(result["stdout"], "firstsecond")
            self.assertEqual(result["stderr"], "problem")
            self.assertEqual(result["exit_code"], 0)
            self.assertIn(("stdout", "first"), events)
            self.assertIn(("stderr", "problem"), events)

    def test_timeout_preserves_output_and_terminates_child_process_group(self):
        with TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
            events = []
            start = time.monotonic()
            result = file_tools.shell_exec("printf started; sleep 5", timeout=0.2, on_output=lambda stream, text: events.append((stream, text)))
            self.assertLess(time.monotonic() - start, 2)
            self.assertEqual(result["exit_code"], -1)
            self.assertEqual(result["stdout"], "started")
            self.assertIn("timed out", result["stderr"])
            self.assertIn(("stdout", "started"), events)

    def test_split_utf8_bytes_are_decoded_without_replacement_characters(self):
        with TemporaryDirectory() as directory, patch.object(file_tools, "WORKSPACE_ROOT", directory):
            command = "python3 -c \"import os,time; os.write(1,bytes([240,159])); time.sleep(.1); os.write(1,bytes([152,128]))\""
            events = []
            result = file_tools.shell_exec(command, timeout=3, on_output=lambda stream, text: events.append(text))
            self.assertEqual(result["stdout"], "😀")
            self.assertEqual("".join(events), "😀")

    def test_manager_reads_live_json_frames_and_returns_final_result(self):
        with TemporaryDirectory() as directory:
            services = str(Path(file_tools.__file__).parent)
            class Runtime:
                fs = SimpleNamespace(write_text=lambda *args: None)
                def exec(self, *args, **kwargs):
                    return LocalDockerProcess(subprocess.Popen([sys.executable, "-u", "-c", args[-1]], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, "PYTHONPATH": services}))
            manager = SandboxSessionManager()
            manager.get_or_create = Mock(return_value=Runtime())
            manager._sync_file_tree_to_db = Mock()
            project = SimpleNamespace(uuid="test", workspace_id="workspace", user_id="user", filesystem_path=directory, slug="project")
            events = []
            started = time.monotonic()
            result = manager.execute_tool(project, "shell_exec", {"command": "printf first; sleep 0.5; printf last", "timeout": 3}, on_output=lambda stream, text: events.append((stream, text, time.monotonic())))
            self.assertEqual(result["stdout"], "firstlast")
            self.assertEqual(events[0][:2], ("stdout", "first"))
            self.assertGreater(time.monotonic() - events[0][2], 0.3)
            self.assertLess(time.monotonic() - started, 4)
            manager._sync_file_tree_to_db.assert_called_once_with(project)

    def test_output_chunk_is_not_mistaken_for_completed_tool_result(self):
        raw = _openai_stateful_tool_result_chunk("completion", 1, "model", {"id": "shell", "output": {"stream": "stdout", "text": "first"}}, "conversation", "request")
        chunk = json.loads(raw.removeprefix("data: "))
        delta = chunk["choices"][0]["delta"]["tool_calls"][0]
        self.assertEqual(delta["output"]["text"], "first")
        self.assertIsNone(delta["result"])

    @patch("chat.services.chat_service.get_all_warm_models", return_value=[])
    def test_chat_emits_output_before_result_and_persists_terminal_transcript(self, _warm):
        from chat.tests.test_unlimited_tool_rounds import UnlimitedToolRoundTests
        service = UnlimitedToolRoundTests().service()
        calls = 0
        def model(*args):
            nonlocal calls
            calls += 1
            if False:
                yield
            if calls == 1:
                return "", None, 1, 2, [{"id": "shell", "function": {"name": "shell_exec", "arguments": '{"command":"printf first"}'}}], 0
            return "Done", None, 1, 2, [], 0
        service._stream_external = model
        events = [("output", '{"stream":"stdout","text":"first"}'),
                  ("output", '{"stream":"stderr","text":"problem"}'),
                  ("result", '{"stdout":"first","stderr":"problem","exit_code":1}')]
        with patch("chat.builtin_tools.execute_builtin_tool_stream", return_value=iter(events)):
            emitted = list(service._generate_stream_events())
        kinds = [event.splitlines()[0] for event in emitted]
        self.assertLess(kinds.index("event: tool_output"), kinds.index("event: tool_result"))
        self.assertEqual(kinds.count("event: tool_output"), 2)
        self.assertEqual(service._save_response.call_args.kwargs["tool_calls"][0]["output"], "firstproblem")
