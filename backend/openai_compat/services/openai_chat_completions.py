"""
OpenAI-compatible ChatService subclass.
"""
import json

from chat.services.chat_service import ChatService


class OpenAIChatService(ChatService):
    def _merge_mcp_tools(self) -> list | None:
        # In OpenAI-compatible endpoint, only merge tools if tools were explicitly requested
        if not self.tools:
            return None
        return super()._merge_mcp_tools()

    def _build_messages(self) -> list:
        messages = list(self.params_messages)
        # Convert tool results to user messages so any model can understand them
        for i, msg in enumerate(messages):
            if msg.get("role") == "tool":
                fn_name = "unknown"
                for j in range(i - 1, -1, -1):
                    prev = messages[j]
                    if prev.get("role") == "assistant" and prev.get("tool_calls"):
                        for tc in prev["tool_calls"]:
                            if tc.get("id") == msg.get("tool_call_id"):
                                fn_name = tc.get("function", {}).get("name", "unknown")
                                break
                        break
                messages[i] = {
                    "role": "user",
                    "content": 'Tool result for function "' + fn_name + '":\n' + (msg.get("content") or "")
                }
        if self.tools:
            tool_info = []
            for t in self.tools:
                fn = t.get("function", {})
                tool_info.append(fn.get("name", "") + ": " + fn.get("description", ""))
            tools_str = ", ".join(tool_info)
            has_tool_result = any(m.get("role") == "user" and m.get("content", "").startswith('Tool result for function "') for m in messages)
            prompt = ("Available tools: " + tools_str + ". "
                      "To call a tool output: <function=name><parameter=key>value</parameter></function>. "
                      + ("You have already received a tool result. "
                         "You may call additional tools if needed, or provide a final response."
                         if has_tool_result else ""))
            messages = [{"role": "system", "content": prompt}] + messages
        return messages

    def __init__(self, model, conversation, current_request, params: dict, predict_start=None):
        self.params_messages = list(params.get("messages") or [])
        import logging
        logging.getLogger(__name__).info("OpenAIChatService init: tools=%s", params.get("tools"))
        super().__init__(model, conversation, current_request, params, predict_start)

    def generate_streaming(self):
        from chat.services.utils import sse_event
        yield sse_event("creating", {"conversation_id": str(self.conversation.uuid)})
        self._persist_token_snapshot(input_tokens=0, output_tokens=0)
        full_response = ""
        thinking_content = None
        tool_calls = None
        phases = []
        tool_round = 1
        try:
            if self.model.is_external:
                full_response, thinking_content, input_tokens, output_tokens, tool_calls, _thinking_duration_ms = yield from self._stream_external(phases, tool_round)
            else:
                full_response, input_tokens, output_tokens, thinking_content, tool_calls, _thinking_duration_ms = yield from self._stream_local(phases, tool_round)
            result = self._save_response(full_response, input_tokens=input_tokens, output_tokens=output_tokens, thinking_content=thinking_content, tool_calls=tool_calls)
            import logging
            logging.getLogger(__name__).info("generate_streaming: tool_calls from stream=%s", tool_calls)
            yield sse_event("complete", result)
        except Exception as e:
            import logging
            e = self._public_generation_error(e)
            logging.getLogger(__name__).error('Provider generation failed')
            self._mark_failed(str(e))
            yield sse_event("failed", {"message": str(e)})

    def generate_sync(self) -> dict:
        try:
            self._persist_token_snapshot(input_tokens=0, output_tokens=0)
            if self.model.is_external:
                content, thinking_content, input_tokens, output_tokens, tool_calls = self._generate_external_sync()
            else:
                content, thinking_content, input_tokens, output_tokens, tool_calls = self._generate_local_sync()
            self._raise_if_canceled(force=True)
            import logging
            logging.getLogger(__name__).info("generate_sync: tool_calls from generate=%s", tool_calls)
            return self._save_response(content, input_tokens=input_tokens, output_tokens=output_tokens, thinking_content=thinking_content, include_full_response=True, tool_calls=tool_calls)
        except Exception as e:
            import logging
            e = self._public_generation_error(e)
            logging.getLogger(__name__).error('Provider generation failed')
            self._mark_failed(str(e))
            return {"error": str(e)}

    def _save_response(self, content: str, input_tokens: int = 0, output_tokens: int = 0, include_full_response: bool = False, thinking_content=None, tool_calls=None) -> dict:
        import logging
        logger = logging.getLogger(__name__)
        logger.info("_save_response: tool_calls=%s, self.tools=%s, has_function=%s, content_preview=%s", tool_calls, bool(self.tools), "function=" in content, repr(content[:200]) if content else None)
        has_valid_tool_calls = tool_calls and any(tc.get("function", {}).get("arguments", "{}") != "{}" for tc in tool_calls)
        if not has_valid_tool_calls and self.tools and content and "function=" in content:
            parts = content.split("function=")
            if len(parts) > 1:
                func_part = parts[1]
                func_name = func_part.split(">")[0]
                if func_name:
                    args = {}
                    # Get known parameter names from tool definitions
                    known_params = set()
                    for tool in self.tools:
                        func_def = tool.get("function", {})
                        params = func_def.get("parameters", {})
                        if "properties" in params:
                            known_params.update(params["properties"].keys())
                    func_part_normalized = func_part.replace("<parameter=", "<parameter>").replace("<parameter=key>", "<parameter>").replace("key>", "")
                    param_parts = func_part_normalized.split("<parameter>")
                    for pp in param_parts[1:]:
                        gt_idx = pp.find(">")
                        if gt_idx == -1:
                            continue
                        pname = pp[:gt_idx]
                        value = pp[gt_idx+1:].split("<")[0].strip()
                        if value and pname in known_params:
                            args[pname] = value
                    tool_calls = [{"id": "call_0", "type": "function", "function": {"name": func_name, "arguments": json.dumps(args)}}]
                    content = content.split("</function>")[0] if "</function>" in content else content
        self.current_request.status = "completed"
        self.current_request.input_tokens = input_tokens
        self.current_request.output_tokens = output_tokens
        self.current_request.save(update_fields=["status", "input_tokens", "output_tokens"])
        self._process_cost_deduction()
        # Strip think tags from content for cleaner OpenAI-compatible output
        if content:
            import re
            content = re.sub('<think>.*?</think>', '', content, flags=re.DOTALL)
        model_name = self.current_request.model.name if self.current_request.model else None
        tag_name = None
        return {"request_id": str(self.current_request.uuid), "conversation_id": str(self.conversation.uuid), "response": content, "thinking": thinking_content, "tool_calls": tool_calls, "model": model_name, "tag": tag_name, "input_tokens": input_tokens, "output_tokens": output_tokens}

    def _ensure_title(self) -> str:
        return ""

