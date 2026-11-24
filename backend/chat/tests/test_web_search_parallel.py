import json
from importlib import import_module
from threading import Barrier, Event, Lock
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.apps import apps
from django.test import SimpleTestCase, TestCase

from chat.models import Tool
from chat.services.chat_service import ChatService, GenerationCanceledError
from chat.services.tool_execution import execute_tool_batch, is_parallel_web_read
from chat.tools.web_search import handle, WEB_SEARCH_TOOL


class WebSearchTests(SimpleTestCase):
    def test_search_does_not_resolve_or_start_workspace_sandbox(self):
        from chat.builtin_tools import execute_builtin_tool
        with patch("chat.builtin_tools.registry_execute", return_value={"status": "ok"}) as execute, patch("sandbox.services.sandbox_service.SandboxBootstrapService.conversation_project") as project:
            result = json.loads(execute_builtin_tool(Mock(), "web_search", {"query": "query"}, conversation=SimpleNamespace(uuid="chat")))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(execute.call_args.args[2], {"query": "query"})
        project.assert_not_called()

    @patch("chat.tools.web_search._get_api_key", return_value="test-key")
    def test_batch_searches_overlap_and_one_failure_keeps_other_results(self, _key):
        started = Barrier(3, timeout=3)

        def search(**kwargs):
            started.wait()
            if kwargs["query"] == "failed":
                raise TimeoutError("slow upstream")
            return {"results": [{"title": "Source", "url": "https://example.com", "content": "x" * 2000}]}

        with patch("tavily.TavilyClient") as client:
            client.return_value.search.side_effect = search
            result = handle(None, {"queries": ["first", "failed", "third"]})
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["count"], 2)
        self.assertEqual([item["query"] for item in result["searches"]], ["first", "failed", "third"])
        self.assertIn("error", result["searches"][1])
        self.assertEqual(len(result["searches"][0]["results"][0]["snippet"]), 1500)
        for call in client.return_value.search.call_args_list:
            self.assertEqual(call.kwargs["timeout"], 15)
            self.assertEqual(call.kwargs["max_results"], 5)
            self.assertFalse(call.kwargs["auto_parameters"])

    @patch("chat.tools.web_search._get_api_key", return_value="test-key")
    def test_single_query_keeps_existing_response_format(self, _key):
        with patch("tavily.TavilyClient") as client:
            client.return_value.search.return_value = {"results": [{"url": "https://example.com", "content": "evidence"}, {"title": "No URL"}]}
            result = handle(None, {"query": " query ", "limit": 50})
        self.assertEqual(result, {"status": "ok", "query": "query", "count": 1, "results": [{"title": "https://example.com", "url": "https://example.com", "snippet": "evidence"}]})
        self.assertEqual(client.return_value.search.call_args.kwargs["max_results"], 20)

    @patch("chat.tools.web_search._get_api_key", return_value="test-key")
    def test_duplicate_queries_are_searched_once(self, _key):
        with patch("tavily.TavilyClient") as client:
            client.return_value.search.return_value = {"results": []}
            result = handle(None, {"queries": ["query", " query "]})
        self.assertEqual(len(result["searches"]), 1)
        client.return_value.search.assert_called_once()

    def test_invalid_inputs_do_not_make_requests(self):
        with patch("tavily.TavilyClient") as client:
            for arguments in [{}, {"query": 1}, {"queries": "query"}, {"queries": []}, {"queries": ["q"] * 5}, {"queries": ["valid", " "]}, {"query": "valid", "limit": "invalid"}]:
                with self.subTest(arguments=arguments):
                    self.assertIn("error", handle(None, arguments))
            client.assert_not_called()


class ParallelWebToolTests(SimpleTestCase):
    def service(self):
        return SimpleNamespace(conversation=SimpleNamespace(user=Mock()), _raise_if_canceled=Mock())

    def call(self, identifier, name="web_search", **arguments):
        return {"id": identifier, "function": {"name": name, "arguments": json.dumps(arguments)}}

    def test_web_reads_overlap_and_fast_results_arrive_first(self):
        slow_finished = Event()
        started = Barrier(2, timeout=3)

        def execute(user, name, args, **kwargs):
            started.wait()
            if name == "web_search":
                if not slow_finished.wait(3):
                    raise TimeoutError("fast result was blocked")
            return json.dumps({"name": name})

        calls = [self.call("slow", query="query"), self.call("fast", "http_request", url="https://api.github.com")]
        results = []
        with patch("chat.builtin_tools.execute_builtin_tool", side_effect=execute):
            try:
                for call, _, event, value, _ in execute_tool_batch(self.service(), calls):
                    if event == "result":
                        results.append((call["id"], value))
                        slow_finished.set()
            finally:
                slow_finished.set()
        self.assertEqual([identifier for identifier, _ in results], ["fast", "slow"])
        self.assertTrue(all("error" not in result for _, result in results))

    def test_parallelism_is_bounded(self):
        lock = Lock()
        active = maximum = 0
        first_wave = Barrier(4, timeout=3)

        def execute(user, name, args, **kwargs):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            try:
                first_wave.wait()
                return '{}'
            finally:
                with lock:
                    active -= 1

        calls = [self.call(str(i), query=str(i)) for i in range(8)]
        with patch("chat.builtin_tools.execute_builtin_tool", side_effect=execute):
            results = [value for _, _, event, value, _ in execute_tool_batch(self.service(), calls) if event == "result"]
        self.assertEqual(maximum, 4)
        self.assertEqual(results, [{}] * 8)

    def test_writes_and_shell_calls_are_ordering_barriers(self):
        calls = [self.call("read-1"), self.call("write", "http_request", method="POST"), self.call("shell", "shell_exec"), self.call("read-2")]
        executed = []

        def execute(user, name, args, **kwargs):
            executed.append(name)
            return '{}'

        with patch("chat.builtin_tools.execute_builtin_tool", side_effect=execute):
            list(execute_tool_batch(self.service(), calls, streaming=False))
        self.assertEqual(executed, ["web_search", "http_request", "shell_exec", "web_search"])
        self.assertTrue(is_parallel_web_read(self.call("head", "http_request", method="head")))
        self.assertFalse(is_parallel_web_read(self.call("mcp", "mcp__web__search")))

    def test_cancel_does_not_wait_for_running_search(self):
        service = self.service()
        started, release, finished = Event(), Event(), Event()

        def execute(*args, **kwargs):
            started.set()
            try:
                release.wait(3)
                return '{}'
            finally:
                finished.set()

        def check(**kwargs):
            if started.is_set():
                raise GenerationCanceledError("canceled")

        service._raise_if_canceled.side_effect = check
        with patch("chat.builtin_tools.execute_builtin_tool", side_effect=execute):
            try:
                with self.assertRaises(GenerationCanceledError):
                    list(execute_tool_batch(service, [self.call("read")]))
                self.assertFalse(finished.is_set())
            finally:
                release.set()
                self.assertTrue(finished.wait(3))

    @patch("chat.services.chat_service.get_all_warm_models", return_value=[])
    def test_streaming_and_sync_feed_all_parallel_results_back_to_model(self, _warm):
        from chat.tests.test_unlimited_tool_rounds import UnlimitedToolRoundTests

        for streaming in (True, False):
            with self.subTest(streaming=streaming):
                service = UnlimitedToolRoundTests().service()
                calls = [self.call("first", query="first"), self.call("second", "http_request", url="https://api.github.com")]
                barrier = Barrier(2, timeout=3)
                model_calls = 0

                def model_response():
                    nonlocal model_calls
                    model_calls += 1
                    if model_calls == 1:
                        return "", None, 1, 2, calls
                    self.assertEqual({message["tool_call_id"] for message in service.messages if message["role"] == "tool"}, {"first", "second"})
                    self.assertTrue(all(call.get("result") == {"ok": True} for call in calls))
                    return "Done", None, 1, 2, []

                def stream_model(*args):
                    if False:
                        yield
                    return (*model_response(), 0)

                def execute(*args, **kwargs):
                    barrier.wait()
                    return '{"ok":true}'

                service._stream_external = stream_model
                service._generate_external_sync = model_response
                with patch("chat.builtin_tools.execute_builtin_tool", side_effect=execute):
                    if streaming:
                        events = list(service._generate_stream_events())
                        starts = [i for i, event in enumerate(events) if event.startswith("event: tool_call")]
                        results = [i for i, event in enumerate(events) if event.startswith("event: tool_result")]
                        self.assertEqual(len(results), 2)
                        self.assertLess(max(starts), min(results))
                        phases = service._save_response.call_args.kwargs["phases"]
                        self.assertEqual({phase["toolCallId"] for phase in phases if phase["type"] == "tool_result"}, {"first", "second"})
                    else:
                        self.assertEqual(service.generate_sync()["response"], "Done")
                self.assertEqual(model_calls, 2)


class WebSearchSchemaTests(TestCase):
    def test_old_database_schema_is_updated_for_model_without_waiting_for_migration(self):
        Tool.objects.create(name="web_search", description="Legacy", enabled=True, is_builtin=True, parameters_schema={"required": ["query"], "properties": {"page": {"type": "integer"}}})
        service = ChatService.__new__(ChatService)
        service.tools = None
        service._get_mcp_tools = lambda: []
        search = next(tool for tool in service._merge_mcp_tools() if tool["function"]["name"] == "web_search")
        self.assertEqual(search, WEB_SEARCH_TOOL)
