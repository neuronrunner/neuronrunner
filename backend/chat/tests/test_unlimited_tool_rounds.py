import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from chat.constants import GENERATION_CANCELED_ERROR
from chat.services.chat_service import ChatService, GenerationCanceledError


class UnlimitedToolRoundTests(SimpleTestCase):
    def service(self, external=True):
        service = ChatService.__new__(ChatService)
        service._settle_round = Mock()
        service._check_workspace_balance = Mock()
        service.model_tag = SimpleNamespace(is_external=external)
        service.conversation = SimpleNamespace(uuid="conversation", user=Mock())
        service.current_request = SimpleNamespace(uuid="request", status="completed", workspace_id=None, uses_byok=False, refresh_from_db=Mock())
        service.user_msg = SimpleNamespace(uuid="user-message")
        service.messages = []
        service._start_memory_thread = Mock()
        service._start_title_generation = Mock(return_value=None)
        service._persist_token_snapshot = Mock()
        service._raise_if_canceled = Mock()
        service._update_partial_state = Mock()
        service._save_partial_response_on_cancel = Mock()
        service._save_partial_response_on_failure = Mock()
        service._save_response = Mock(side_effect=lambda content, **kwargs: {"response": content, **kwargs})
        return service

    def tool(self, index=0, name="file_read"):
        return {"id": f"tool-{index}", "function": {"name": name, "arguments": json.dumps({"path": f"/workspace/file-{index}.txt"})}}

    def install_responses(self, service, rounds):
        calls = []

        def response():
            index = len(calls)
            calls.append(index)
            if index == rounds:
                # The final result must be fed back to the model, rather than silently dropped.
                self.assertEqual(service.messages[-1]["role"], "tool")
                self.assertEqual(service.messages[-1]["tool_call_id"], f"tool-{rounds - 1}")
                return "Task completed", None, 1, 2, []
            return "", None, 1, 2, [self.tool(index)]

        def stream_external(*args):
            content, thinking, input_tokens, output_tokens, tools = response()
            if content:
                yield 'event: message\ndata: {"v": "Task completed"}\n\n'
            return content, thinking, input_tokens, output_tokens, tools, 0

        def stream_local(*args):
            content, thinking, input_tokens, output_tokens, tools = response()
            if content:
                yield 'event: message\ndata: {"v": "Task completed"}\n\n'
            return content, input_tokens, output_tokens, thinking, tools, 0

        service._stream_external = stream_external
        service._stream_local = stream_local
        service._generate_external_sync = response
        service._generate_local_sync = response
        return calls

    @patch("chat.services.chat_service.get_all_warm_models", return_value=[])
    def test_all_generation_paths_continue_past_ten_and_one_hundred_rounds(self, _warm):
        for streaming in [True, False]:
            for external in [True, False]:
                with self.subTest(streaming=streaming, external=external):
                    service = self.service(external)
                    calls = self.install_responses(service, 104)
                    with patch("chat.builtin_tools.execute_builtin_tool_stream", side_effect=lambda *args, **kwargs: iter([("result", '{"content":"file contents"}')])), patch("chat.builtin_tools.execute_builtin_tool", return_value='{"content":"file contents"}'):
                        if streaming:
                            events = list(service._generate_stream_events())
                            self.assertTrue(events[-1].startswith("event: complete"))
                        else:
                            result = service.generate_sync()
                            self.assertEqual(result["response"], "Task completed")
                    self.assertEqual(len(calls), 105)
                    self.assertEqual(service._save_response.call_args.args[0], "Task completed")
                    self.assertEqual(len(service._save_response.call_args.kwargs["tool_calls"]), 104)
                    self.assertEqual(service._save_response.call_args.kwargs["input_tokens"], 105)
                    self.assertEqual(service._save_response.call_args.kwargs["output_tokens"], 210)

    @patch("chat.services.chat_service.get_all_warm_models", return_value=[])
    def test_cancel_between_tools_prevents_next_tool_and_saves_partial_work(self, _warm):
        for streaming in [True, False]:
            with self.subTest(streaming=streaming):
                service = self.service()
                tools = [self.tool(0), self.tool(1)]
                service._generate_external_sync = Mock(return_value=("", None, 1, 2, tools))

                def model_stream(*args):
                    if False:
                        yield
                    return "", None, 1, 2, tools, 0

                service._stream_external = model_stream
                canceled = False

                def check(**kwargs):
                    if canceled:
                        service.current_request.status = "canceled"
                        raise GenerationCanceledError(GENERATION_CANCELED_ERROR)

                def tool_result(*args, **kwargs):
                    nonlocal canceled
                    canceled = True
                    return '{"content":"first result"}'

                def stream_result(*args, **kwargs):
                    return iter([("result", tool_result())])

                service._raise_if_canceled.side_effect = check
                with patch("chat.builtin_tools.execute_builtin_tool_stream", side_effect=stream_result) as stream_tool, patch("chat.builtin_tools.execute_builtin_tool", side_effect=tool_result) as sync_tool:
                    if streaming:
                        events = list(service._generate_stream_events())
                        self.assertTrue(events[-1].startswith("event: failed"))
                        self.assertEqual(stream_tool.call_count, 1)
                    else:
                        self.assertEqual(service.generate_sync()["error"], GENERATION_CANCELED_ERROR)
                        self.assertEqual(sync_tool.call_count, 1)
                service._save_response.assert_not_called()
                service._save_partial_response_on_cancel.assert_called_once()
                self.assertEqual(service._save_partial_response_on_cancel.call_args.kwargs["tool_calls"][0]["result"], {"content": "first result"})

    def test_identical_calls_nudge_a_different_approach_without_stopping(self):
        service = self.service()
        for index in range(3):
            service._track_tool_progress("shell_exec", {"command": "missing-command"}, {"exit_code": 127, "stderr": "not found"})
            # Guidance must not interrupt a batch of tool result messages.
            self.assertEqual(service.messages, [])
        service._apply_tool_progress_guidance()
        self.assertEqual(len(service.messages), 1)
        self.assertEqual(service.messages[0]["role"], "system")
        self.assertIn("different approach", service.messages[0]["content"])
        self.assertIn("not by itself a reason to stop", service.messages[0]["content"])
        service._apply_tool_progress_guidance()
        self.assertEqual(len(service.messages), 1)

    @patch("chat.services.chat_service.get_all_warm_models", return_value=[])
    def test_progress_guidance_follows_all_results_in_a_tool_batch(self, _warm):
        for streaming in [True, False]:
            with self.subTest(streaming=streaming):
                service = self.service()
                batch = [self.tool(0) for _ in range(3)]
                for index, tool in enumerate(batch):
                    tool["id"] = f"batch-{index}"
                model_calls = 0

                def response():
                    nonlocal model_calls
                    model_calls += 1
                    if model_calls == 1:
                        return "", None, 1, 2, batch
                    self.assertEqual([message["role"] for message in service.messages], ["assistant", "tool", "tool", "tool", "system"])
                    return "A different approach is needed", None, 1, 2, []

                def model_stream(*args):
                    if False:
                        yield
                    return (*response(), 0)

                service._stream_external = model_stream
                service._generate_external_sync = response
                with patch("chat.builtin_tools.execute_builtin_tool_stream", side_effect=lambda *args, **kwargs: iter([("result", '{"error":"same failure"}')])), patch("chat.builtin_tools.execute_builtin_tool", return_value='{"error":"same failure"}'):
                    if streaming:
                        list(service._generate_stream_events())
                    else:
                        service.generate_sync()
                self.assertEqual(model_calls, 2)
                self.assertEqual(service._save_response.call_args.args[0], "A different approach is needed")

    def test_changed_inputs_or_results_reset_repetition_detection(self):
        service = self.service()
        for index in range(6):
            service._track_tool_progress("shell_exec", {"command": "check progress"}, {"stdout": str(index)})
        service._apply_tool_progress_guidance()
        self.assertEqual(service.messages, [])
        for index in range(6):
            service._track_tool_progress("file_read", {"path": f"file-{index}"}, {"content": "same"})
        service._apply_tool_progress_guidance()
        self.assertEqual(service.messages, [])

    def test_equivalent_argument_key_order_counts_as_same_call(self):
        service = self.service()
        for args in [{"command": "same", "timeout": 30}, {"timeout": 30, "command": "same"}, {"command": "same", "timeout": 30}]:
            service._track_tool_progress("shell_exec", args, {"stdout": "unchanged"})
        service._apply_tool_progress_guidance()
        self.assertEqual(len(service.messages), 1)
