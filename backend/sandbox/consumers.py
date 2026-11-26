"""WebSocket consumers for interactive Docker PTY terminals and real-time request updates."""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pty
import shlex
import struct
import subprocess
import termios
import threading
import time
import uuid
from urllib.parse import parse_qs

from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.core import signing

from sandbox.models import Sandbox
from sandbox.services.sandbox_session import get_sandbox_manager

logger = logging.getLogger(__name__)
WS_AUTH_TIMEOUT = 10
TERMINAL_HEARTBEAT_INTERVAL = 5
WS_RUNTIME_UNAVAILABLE = 4500
WS_INVALID_MESSAGE = 4400
WS_MESSAGE_TOO_LARGE = 4409

_JSON_ENCODER = json.JSONEncoder(separators=(',', ':'))


def _encode_output(text: str) -> str:
    return '{"type":"output","data":' + _JSON_ENCODER.encode(text) + '}'


@database_sync_to_async
def _get_user_from_token(token_str: str):
    from rest_framework_simplejwt.authentication import JWTAuthentication
    from rest_framework_simplejwt.tokens import AccessToken
    try:
        return JWTAuthentication().get_user(AccessToken(token_str))
    except Exception:
        return None


@database_sync_to_async
def _terminal_access(payload, sandbox_uuid):
    from .ws_security import can_access_sandbox, ticket_user
    user = ticket_user(payload)
    project = Sandbox.objects.select_related("workspace").filter(uuid=sandbox_uuid).first()
    return project if project and can_access_sandbox(user, project) else None


class TerminalConsumer(AsyncWebsocketConsumer):
    """Interactive browser terminal backed by a local PTY attached to the workspace Docker container."""

    async def connect(self):
        self.authenticated = False
        self.failure_reported = False
        self.is_connected = True
        self.auth_task = None
        self.direct_terminal = None
        self.output_task = self.write_task = self.heartbeat_task = None
        self.reader_thread = None
        self.local_master_fd = None
        self.local_proc = None
        self.output_queue = asyncio.Queue()
        self.sandbox_uuid = self.scope["url_route"]["kwargs"]["sandbox_uuid"]
        params = parse_qs(self.scope.get("query_string", b"").decode())
        # Self-hosted named runtime picked in the UI; empty selects the default runtime.
        self.runtime_name = (params.get("vm_uuid") or params.get("runtime") or [""])[0]
        if "token" in params or "ticket" in params:
            await self.close(code=4001)
            return
        try:
            self.initial_cols = max(1, min(500, int(params.get("cols", [80])[0])))
            self.initial_rows = max(1, min(500, int(params.get("rows", [24])[0])))
        except (TypeError, ValueError):
            await self.close(code=WS_INVALID_MESSAGE)
            return
        await self.accept()
        self.auth_task = asyncio.create_task(self._authentication_timeout())

    async def _authentication_timeout(self):
        await asyncio.sleep(WS_AUTH_TIMEOUT)
        if not self.authenticated:
            await self.close(code=4001)

    async def _authorize(self):
        if self.auth_payload["session_exp"] <= time.time():
            self.is_connected = False
            await self.close(code=4001)
            return False
        project = await _terminal_access(self.auth_payload, self.sandbox_uuid)
        if project is None:
            self.is_connected = False
            await self.close(code=4003)
            return False
        self.project = project
        return True

    async def _start_terminal(self):
        self.output_task = None
        self.write_task = None
        self.heartbeat_task = None
        self.reader_thread = None
        self.is_connected = True
        self.session_id = str(uuid.uuid4())
        self.input_queue = asyncio.Queue(maxsize=128)
        self.cmd_buffer = ""
        self.output_queue = asyncio.Queue()
        self.local_master_fd = None
        self.local_proc = None

        self._write_stdin_async = sync_to_async(self._write_stdin_sync, thread_sensitive=False)
        self._resize_pty_async = sync_to_async(self._resize_pty_sync, thread_sensitive=False)
        self._record_cmd_async = sync_to_async(self.manager_record_terminal_command, thread_sensitive=False)
        self._update_activity_async = database_sync_to_async(self.manager_update_activity, thread_sensitive=False)

        if await self._open_direct_terminal():
            return

        self.manager = get_sandbox_manager()
        try:
            self.sandbox = await database_sync_to_async(
                self.manager.get_or_create, thread_sensitive=False
            )(self.project, runtime=self.runtime_name)
        except Exception:
            logger.exception("Docker sandbox startup failed for %s", self.sandbox_uuid)
            await self._runtime_failure("Sandbox container failed to start. Check that Docker is running and reconnect.")
            return

        container_name = getattr(self.sandbox, "container_name", None) or getattr(self.sandbox, "object_id", "")
        if not container_name:
            await self._runtime_failure("Sandbox runtime unavailable.")
            return

        project_path = self.project.filesystem_path or f"/workspace/{self.project.slug}"
        try:
            master_fd, slave_fd = pty.openpty()
            wsz = struct.pack("HHHH", self.initial_rows, self.initial_cols, 0, 0)
            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, wsz)

            shell_cmd = (
                f"mkdir -p {shlex.quote(project_path)} && "
                f"cd {shlex.quote(project_path)} && "
                "if command -v bash >/dev/null 2>&1; then exec bash -i; else exec sh -i; fi"
            )
            docker_cmd = [
                "docker", "exec", "-it",
                "-e", "TERM=xterm-256color",
                "-e", "COLORTERM=truecolor",
                "-e", "PS1=\\[\\033[01;32m\\]\\u@workspace\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ",
                container_name,
                "sh", "-c", shell_cmd,
            ]
            proc = subprocess.Popen(
                docker_cmd,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                close_fds=True,
                start_new_session=True,
            )
            os.close(slave_fd)
            self.local_master_fd = master_fd
            self.local_proc = proc

            await self._record_terminal_connect()
            self.output_task = asyncio.create_task(self._read_output())
            self.write_task = asyncio.create_task(self._write_loop())
            self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            await self.send(text_data=json.dumps({"type": "ready"}))
        except Exception as exc:
            logger.exception("Error spawning container PTY for %s: %s", self.sandbox_uuid, exc)
            await self._runtime_failure("Terminal startup failed. Please reconnect.")

    async def _open_direct_terminal(self) -> bool:
        """Let an extension attach the browser straight to a remote runtime; True when it took over."""
        from core.extensions import registry as ext_registry

        opener = ext_registry.runtime.open_direct_terminal
        if opener is None:
            return False
        origin = dict(self.scope.get("headers", [])).get(b"origin", b"").decode()
        try:
            self.direct_terminal = await asyncio.to_thread(
                opener, self.project, self.runtime_name, self.auth_payload, origin
            )
        except Exception as exc:
            logger.exception("Direct terminal setup failed for %s", self.sandbox_uuid)
            await self._runtime_failure(
                str(exc) if isinstance(exc, ValueError) and str(exc) else "Terminal connection failed. Please reconnect."
            )
            return True
        if self.direct_terminal is None:
            return False
        await self._record_terminal_connect()
        await self.send(text_data=json.dumps(self.direct_terminal.descriptor()))
        # Only startup uses Django: close this control socket once the ticket window ends.
        self.auth_task = asyncio.create_task(self._direct_startup_timeout())
        return True

    async def _direct_startup_timeout(self):
        await asyncio.sleep(max(0, self.direct_terminal.claims["expires"] - time.time()))
        await self.close(code=4001)

    async def _runtime_failure(self, message):
        if self.failure_reported:
            return
        self.failure_reported = True
        self.is_connected = False
        if self.auth_task:
            self.auth_task.cancel()
        await self.send(text_data=json.dumps({"type": "error", "code": "runtime_unavailable", "data": message}))
        await self.close(code=WS_RUNTIME_UNAVAILABLE)

    async def disconnect(self, code):
        self.is_connected = False
        if self.auth_task:
            self.auth_task.cancel()
        if self.local_master_fd is not None:
            try:
                os.close(self.local_master_fd)
            except Exception:
                pass
            self.local_master_fd = None
        if self.local_proc is not None:
            try:
                self.local_proc.terminate()
            except Exception:
                pass
            self.local_proc = None

        cur_task = asyncio.current_task()
        for task in (self.output_task, self.write_task, self.heartbeat_task):
            if task and task != cur_task:
                task.cancel()
        await self.output_queue.put(None)

    def _write_stdin_sync(self, data: bytes):
        if self.local_master_fd is not None:
            try:
                os.write(self.local_master_fd, data)
            except Exception as exc:
                logger.error("Error writing to container PTY: %s", exc)

    def _resize_pty_sync(self, cols: int, rows: int):
        if self.local_master_fd is not None:
            try:
                wsz = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.local_master_fd, termios.TIOCSWINSZ, wsz)
            except Exception as exc:
                logger.error("Failed to resize container PTY: %s", exc)

    async def _heartbeat_loop(self):
        try:
            while self.is_connected:
                if not await self._authorize():
                    return
                await self._update_activity_async(str(self.project.uuid))
                await asyncio.sleep(TERMINAL_HEARTBEAT_INTERVAL)
        except asyncio.CancelledError:
            pass
        except Exception:
            await self._runtime_failure("Terminal connection lost. Please reconnect.")

    async def _write_loop(self):
        try:
            while self.is_connected:
                data = await self.input_queue.get()
                while not self.input_queue.empty():
                    data += self.input_queue.get_nowait()
                await self._write_stdin_async(data)
                self.input_queue.task_done()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("Error in write loop: %s", exc)

    @database_sync_to_async
    def _record_terminal_connect(self) -> None:
        from sandbox.models import SandboxAuditLog
        from sandbox.services.audit_log import record_sandbox_audit
        auth = getattr(self, "auth_payload", None) or {}
        record_sandbox_audit(
            event_type=SandboxAuditLog.EVENT_TERMINAL_CONNECT,
            user_id=str(auth.get("user_id") or "") or None,
            sandbox=getattr(self, "project", None),
            runtime_id=getattr(self.project, "sandbox_object_id", ""),
            scope=self.scope,
            metadata={"session_id": getattr(self, "session_id", "")},
        )

    def manager_update_activity(self, project_uuid: str) -> None:
        self.manager.update_activity(project_uuid, runtime=getattr(self, "runtime_name", "") or "")

    def manager_record_terminal_command(self, project: "Sandbox", cmd: str) -> None:
        self.manager.record_terminal_command(project, cmd)
        from sandbox.models import SandboxAuditLog, SandboxEvent
        from sandbox.services.audit_log import record_sandbox_audit, record_sandbox_event
        auth = getattr(self, "auth_payload", None) or {}
        record_sandbox_audit(
            event_type=SandboxAuditLog.EVENT_TERMINAL_COMMAND,
            user_id=str(auth.get("user_id") or "") or None,
            sandbox=project,
            runtime_id=getattr(project, "sandbox_object_id", ""),
            scope=self.scope,
            command=cmd,
        )
        record_sandbox_event(
            sandbox=project,
            event_type=SandboxEvent.EVENT_SHELL,
            payload={"source": "terminal", "command": cmd[:500]},
        )

    async def receive(self, text_data=None, bytes_data=None):
        if not self.is_connected:
            return
        if not text_data or len(text_data) > 65536:
            await self.close(code=WS_MESSAGE_TOO_LARGE)
            return
        if not self.authenticated:
            try:
                from .ws_security import consume_ticket
                message = json.loads(text_data)
                if message.get("type") != "auth" or not isinstance(message.get("ticket"), str):
                    raise ValueError("Authentication required")
                self.auth_payload = await sync_to_async(consume_ticket)(message["ticket"], self.sandbox_uuid)
                if not await self._authorize():
                    return
            except (signing.BadSignature, ValueError, TypeError, KeyError):
                self.is_connected = False
                await self.close(code=4001)
                return
            except Exception:
                logger.exception("Terminal ticket verification unavailable for %s", self.sandbox_uuid)
                await self._runtime_failure("Terminal authentication is temporarily unavailable. Please reconnect.")
                return
            self.authenticated = True
            self.auth_task.cancel()
            try:
                await self._start_terminal()
            except Exception:
                logger.exception("Terminal startup failed for %s", self.sandbox_uuid)
                await self._runtime_failure("Terminal startup failed. Please reconnect.")
            return

        if self.direct_terminal:
            try:
                message = json.loads(text_data)
                if message.get("type") != "consume":
                    raise ValueError("Only consumption requests are accepted")
                if not await self._authorize():
                    return
                receipt = await sync_to_async(self.direct_terminal.consume)(message.get("challenge"))
                await self.send(text_data=json.dumps({
                    "type": "consumed", "receipt": receipt, "session": self.direct_terminal.claims["session"],
                }))
                await self.close(code=1000)
            except (ValueError, TypeError, KeyError):
                await self.close(code=4001)
            except Exception:
                await self._runtime_failure("Terminal authentication is temporarily unavailable. Please reconnect.")
            return

        if not await self._authorize():
            return
        try:
            msg = json.loads(text_data)
            if msg.get('type') == 'input':
                raw_data = msg.get('data', '')
                self.input_queue.put_nowait(raw_data.encode('utf-8'))
                for char in raw_data:
                    if char in ("\r", "\n"):
                        cmd = self.cmd_buffer.strip()
                        if cmd and not cmd.startswith("["):
                            asyncio.create_task(self._record_cmd_async(self.project, cmd))
                        self.cmd_buffer = ""
                    elif char in ("\x7f", "\x08"):
                        if self.cmd_buffer:
                            self.cmd_buffer = self.cmd_buffer[:-1]
                    elif ord(char) < 32:
                        if char == "\x1b":
                            self.cmd_buffer = ""
                    elif len(char) == 1 and char.isprintable():
                        self.cmd_buffer += char
            elif msg.get('type') == 'resize':
                cols = msg.get('cols')
                rows = msg.get('rows')
                if isinstance(cols, int) and isinstance(rows, int) and 1 <= cols <= 500 and 1 <= rows <= 500:
                    asyncio.create_task(self._resize_pty_async(cols, rows))
                else:
                    await self.close(code=WS_INVALID_MESSAGE)
        except (ValueError, TypeError, asyncio.QueueFull):
            await self.close(code=WS_INVALID_MESSAGE)

    def _queue_output(self, loop, chunk):
        if not self.is_connected or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self.output_queue.put_nowait, chunk)
        except RuntimeError:
            if not loop.is_closed():
                raise

    def _pty_reader_thread(self, loop: asyncio.AbstractEventLoop):
        fd = self.local_master_fd
        try:
            while self.is_connected and fd is not None:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                self._queue_output(loop, chunk)
        except OSError:
            pass
        except Exception as exc:
            self._queue_output(loop, exc)
        finally:
            self._queue_output(loop, None)

    async def _read_output(self):
        try:
            loop = asyncio.get_running_loop()
            self.reader_thread = threading.Thread(
                target=self._pty_reader_thread, args=(loop,), daemon=True
            )
            self.reader_thread.start()
            while self.is_connected:
                chunk = await self.output_queue.get()
                if chunk is None:
                    break
                if isinstance(chunk, Exception):
                    logger.error("PTY reader thread error: %s", chunk)
                    if self.is_connected:
                        await self.send(text_data=json.dumps({"type": "error", "data": "Terminal connection lost."}))
                    break
                text = chunk.decode('utf-8', errors='replace') if isinstance(chunk, bytes) else str(chunk)
                if text:
                    await self.send(text_data=_encode_output(text))
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("Error reading PTY output: %s", exc)
            if self.is_connected:
                await self.send(text_data=json.dumps({"type": "error", "data": "Terminal connection lost."}))
        finally:
            if self.is_connected:
                await self.close()


class RequestStatusConsumer(AsyncWebsocketConsumer):
    """WebSocket consumer that pushes real-time updates of a Request to the frontend."""

    async def connect(self):
        self.group_name = None
        self.authenticated = False
        self.auth_timeout_task = None
        self.validation_task = None
        self.request_uuid = self.scope["url_route"]["kwargs"]["request_uuid"]
        if b"token=" in self.scope.get("query_string", b""):
            await self.close(code=4001)
            return
        await self.accept()
        self.auth_timeout_task = asyncio.create_task(self._auth_timeout())

    async def _auth_timeout(self):
        await asyncio.sleep(WS_AUTH_TIMEOUT)
        if not self.authenticated:
            await self.close(code=4001)

    async def _authenticate(self, token_str):
        user = await _get_user_from_token(token_str)
        if not user:
            await self.close(code=4001)
            return
        self.request_uuid = self.scope['url_route']['kwargs']['request_uuid']
        user_id = await self._get_request_user_id()
        if not user_id or str(user_id) != str(getattr(user, "uuid", "")):
            await self.close(code=4003)
            return

        self.group_name = f"request_{self.request_uuid}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        self.authenticated = True
        self.auth_token = token_str
        self.auth_timeout_task.cancel()
        self.validation_task = asyncio.create_task(self._validate_session())
        await self.send_initial_status()

    async def disconnect(self, code):
        if self.auth_timeout_task:
            self.auth_timeout_task.cancel()
        if self.validation_task:
            self.validation_task.cancel()
        if self.group_name:
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def _validate_session(self):
        try:
            while True:
                await asyncio.sleep(5)
                if not await _get_user_from_token(self.auth_token):
                    await self.close(code=4001)
                    return
        except asyncio.CancelledError:
            pass
        except Exception:
            await self.close(code=WS_RUNTIME_UNAVAILABLE)

    async def receive(self, text_data=None, bytes_data=None):
        if self.authenticated:
            return
        try:
            if not text_data or len(text_data) > 8192:
                raise ValueError("Invalid authentication message")
            message = json.loads(text_data)
            if message.get("type") != "auth" or not isinstance(message.get("token"), str):
                raise ValueError("Authentication required")
            await self._authenticate(message["token"])
        except (ValueError, TypeError):
            await self.close(code=4001)

    async def request_update(self, event):
        await self.send(text_data=json.dumps({
            "type": "request_update",
            "request": event["request"],
        }))

    async def send_initial_status(self):
        try:
            data = await self._get_serialized_request()
            if data:
                await self.send(text_data=json.dumps({
                    "type": "request_update",
                    "request": data,
                }))
        except Exception as exc:
            logger.error("Error sending initial request status: %s", exc, exc_info=True)

    @database_sync_to_async
    def _get_request_user_id(self):
        from chat.models import Request
        req = Request.objects.filter(uuid=self.request_uuid).select_related('conversation__user', 'user').first()
        if req:
            if req.user_id:
                return req.user_id
            if req.conversation and req.conversation.user_id:
                return req.conversation.user_id
        return None

    @database_sync_to_async
    def _get_serialized_request(self):
        from chat.models import Request
        from chat.views.serializers import serialize_request
        req = Request.objects.filter(uuid=self.request_uuid).first()
        if req:
            return serialize_request(req)
        return None
