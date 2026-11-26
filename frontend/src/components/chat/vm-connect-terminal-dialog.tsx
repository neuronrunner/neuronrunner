"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  LuCheck,
  LuCopy,
  LuExternalLink,
  LuLoader,
  LuPlay,
  LuRefreshCw,
  LuServer,
  LuShieldCheck,
  LuTerminal,
} from "react-icons/lu";
import { AntigravityBrandLogo, ClaudeBrandLogo, OpenAICodexBrandLogo } from "@/components/brand-logos";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authedAxios } from "@/lib/axios";
import { env } from "@/lib/env";
import useAuthStore from "@/stores/auth";

export type ByosProvider = "anthropic_sub" | "openai_sub" | "antigravity_sub";

interface VmLoginPrepareResponse {
  provider: ByosProvider;
  sandbox_uuid: string;
  vm_uuid: string | null;
  vm_status?: string;
  vm_name?: string | null;
  status_detail?: string;
  ready?: boolean;
  default_duration_minutes?: number;
  login_command: string;
}

interface Props {
  open: boolean;
  provider: ByosProvider | null;
  workspaceUuid?: string | null;
  onOpenChange: (open: boolean) => void;
  onConnected: (provider: ByosProvider) => Promise<void> | void;
}

const API_BASE = env.API_URL || "";

// Strip ANSI escape sequences before extracting login URLs / device codes from PTY output.
const ANSI_ESCAPE_RE = /(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const AUTH_URL_RE = /https:\/\/(?:claude\.ai|claude\.com|console\.anthropic\.com|platform\.claude\.com|auth\.openai\.com|accounts\.google\.com)\/[^\s"'<>)\]]+/g;
const DEVICE_CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;

function getProviderMeta(provider: ByosProvider, t: TFunction<"landing">) {
  if (provider === "anthropic_sub") {
    return {
      name: t("home.agentSelector.agents.claude.name", { defaultValue: "Claude Code" }),
      desc: t("home.agentSelector.agents.claude.desc", { defaultValue: "Claude Pro / Max subscription" }),
      logo: <ClaudeBrandLogo className="h-4 w-4" />,
    };
  }
  if (provider === "openai_sub") {
    return {
      name: t("home.agentSelector.agents.codex.name", { defaultValue: "OpenAI Codex" }),
      desc: t("home.agentSelector.agents.codex.desc", { defaultValue: "ChatGPT Plus / Pro subscription" }),
      logo: <OpenAICodexBrandLogo className="h-4 w-4" />,
    };
  }
  return {
    name: t("home.agentSelector.agents.antigravity.name", { defaultValue: "Antigravity" }),
    desc: t("home.agentSelector.agents.antigravity.desc", { defaultValue: "Google Antigravity / Gemini OAuth" }),
    logo: <AntigravityBrandLogo className="h-4 w-4" />,
  };
}

function extractErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: string; error?: string; api_key?: string[] } } })?.response?.data;
  if (detail?.api_key?.[0]) return detail.api_key[0];
  if (detail?.error) return detail.error;
  if (detail?.detail) return detail.detail;
  return err instanceof Error ? err.message : fallback;
}

export default function VmConnectTerminalDialog({
  open,
  provider,
  workspaceUuid,
  onOpenChange,
  onConnected,
}: Props) {
  const { t } = useTranslation("landing");
  const { theme, resolvedTheme } = useTheme();
  const token = useAuthStore((s) => s.token);
  const selectedVMUuid: string | null = null;
  const fetchVMs = async (_ws?: string, _force?: boolean) => {};
  const isLight =
    resolvedTheme === "light" ||
    (resolvedTheme !== "dark" && (theme === "light" || (typeof document !== "undefined" && document.documentElement.classList.contains("light"))));

  const terminalHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const controlWsRef = useRef<WebSocket | null>(null);
  const activeVmUuidRef = useRef<string | null>(null);
  const outputBufferRef = useRef("");
  const commandDispatchedRef = useRef(false);
  const syncedRef = useRef(false);
  // The 3 s poll must never overlap itself: slow responses used to trigger several "connected" toasts.
  const syncInFlightRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  const fetchVMsRef = useRef(fetchVMs);
  fetchVMsRef.current = fetchVMs;

  const [status, setStatus] = useState<"preparing" | "needs_vm" | "starting_vm" | "connecting" | "ready" | "error">("preparing");
  const [vmName, setVmName] = useState<string | null>(null);
  const [defaultDurationMinutes, setDefaultDurationMinutes] = useState<number>(5);
  const [createVmOnStart, setCreateVmOnStart] = useState(false);
  const [attemptNonce, setAttemptNonce] = useState(0);
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [detectedCode, setDetectedCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [pasteCode, setPasteCode] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Forward an authorization code pasted in the dialog to the CLI's stdin.
  // Text and Enter are sent separately so TUI prompts treat Enter as a keypress, not part of a paste.
  const submitPastedCode = useCallback((): boolean => {
    const code = pasteCode.trim();
    const ws = wsRef.current;
    if (!code || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "input", data: code }));
    window.setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: "\r" }));
      }
    }, 150);
    setPasteCode("");
    return true;
  }, [pasteCode]);

  const cleanupConnection = useCallback(() => {
    for (const sock of new Set([wsRef.current, controlWsRef.current])) {
      if (!sock) continue;
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      try {
        sock.close(1000);
      } catch {
        // Ignore close errors
      }
    }
    wsRef.current = null;
    controlWsRef.current = null;
    if (termRef.current) {
      try {
        termRef.current.dispose();
      } catch {
        // Ignore dispose errors
      }
      termRef.current = null;
    }
    fitAddonRef.current = null;
  }, []);

  const syncFromVm = useCallback(
    async (silent: boolean) => {
      if (!workspaceUuid || !provider || syncedRef.current || syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      if (!silent) {
        setIsSyncing(true);
        setErrorText(null);
      }
      try {
        await authedAxios.post(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/provider-keys/sync-from-vm/`, {
          provider,
          ...(activeVmUuidRef.current ? { vm_uuid: activeVmUuidRef.current } : {}),
        });
        syncedRef.current = true;
        cleanupConnection();
        onOpenChange(false);
        await onConnected(provider);
      } catch (err) {
        if (!silent) {
          setErrorText(
            extractErrorMessage(
              err,
              t("home.agentSelector.oauth.syncFailed", {
                defaultValue: "No credentials detected yet. Complete the login in the terminal above, then click Verify & Connect.",
              })
            )
          );
        }
      } finally {
        syncInFlightRef.current = false;
        if (!silent) {
          setIsSyncing(false);
        }
      }
    },
    [cleanupConnection, onConnected, onOpenChange, provider, t, workspaceUuid]
  );

  const handleVerifyAndConnect = useCallback(async () => {
    if (pasteCode.trim()) {
      const sent = submitPastedCode();
      if (sent) {
        setIsSyncing(true);
        setErrorText(null);
        try {
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
            if (syncedRef.current) return;
            await syncFromVm(true);
            if (syncedRef.current) return;
          }
          await syncFromVm(false);
        } finally {
          setIsSyncing(false);
        }
        return;
      }
    }
    await syncFromVm(false);
  }, [pasteCode, submitPastedCode, syncFromVm]);

  useEffect(() => {
    if (!open || !provider || !workspaceUuid) {
      cleanupConnection();
      activeVmUuidRef.current = null;
      setCreateVmOnStart(false);
      return;
    }

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: number | null = null;
    let readyTimeout: number | null = null;
    let retryTimer: number | null = null;
    outputBufferRef.current = "";
    commandDispatchedRef.current = false;
    syncedRef.current = false;
    activeVmUuidRef.current = null;
    setStatus("preparing");
    setVmName(null);
    setDetectedUrl(null);
    setDetectedCode(null);
    setErrorText(null);

    const scanOutputChunk = (chunkText: string) => {
      const cleaned = chunkText.replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "");
      outputBufferRef.current = (outputBufferRef.current + cleaned).slice(-12000);

      // Rejoin only wrapped terminal lines (previous line near terminal width) whose continuation is a
      // single whitespace-free token, so a natural line break like `...state=XYZ\nPaste code here if
      // prompted >` never glues the next line's first word onto an OAuth URL.
      const wrapThreshold = Math.max(60, (termRef.current?.cols || 80) - 2);
      const rawLines = outputBufferRef.current.split("\n");
      const joinedLines: string[] = [];
      for (const line of rawLines) {
        if (
          joinedLines.length > 0 &&
          joinedLines[joinedLines.length - 1].length >= wrapThreshold &&
          /^\S+\s*$/.test(line)
        ) {
          joinedLines[joinedLines.length - 1] += line;
        } else {
          joinedLines.push(line);
        }
      }

      const urlMatches = joinedLines.join("\n").match(AUTH_URL_RE);
      if (urlMatches && urlMatches.length > 0) {
        setDetectedUrl(urlMatches[urlMatches.length - 1]);
      }
      if (provider === "openai_sub") {
        const codeMatch = outputBufferRef.current.match(DEVICE_CODE_RE);
        if (codeMatch?.[1]) {
          setDetectedCode(codeMatch[1]);
        }
      }
    };

    const startTerminal = async () => {
      try {
        const preferredVmUuid = selectedVMUuid || undefined;
        let prepRes = await authedAxios.post<VmLoginPrepareResponse>(
          `${API_BASE}/sandbox/workspaces/${workspaceUuid}/provider-keys/vm-login/`,
          {
            provider,
            ...(preferredVmUuid ? { vm_uuid: preferredVmUuid } : {}),
            auto_start: true,
            create_vm: createVmOnStart,
          }
        );
        if (disposed) return;

        let prepData = prepRes.data;
        setDefaultDurationMinutes(prepData.default_duration_minutes || 5);
        setVmName(prepData.vm_name || null);

        if (prepData.vm_status === "none" || !prepData.vm_uuid) {
          setStatus("needs_vm");
          return;
        }

        // Wait for pending/provisioning/stopping VMs to reach running before opening WebSocket.
        const pollStartedAt = Date.now();
        while (!disposed && (!prepData.ready || !prepData.vm_uuid)) {
          if (prepData.vm_status === "error" || prepData.vm_status === "stopped") {
            setStatus("error");
            setErrorText(
              prepData.status_detail ||
                t("home.agentSelector.oauth.vmBootFailed", {
                  defaultValue: "Virtual machine could not be started.",
                })
            );
            return;
          }
          if (Date.now() - pollStartedAt > 120000) {
            setStatus("error");
            setErrorText(
              t("home.agentSelector.oauth.vmBootTimeout", {
                defaultValue: "Virtual machine startup timed out. Please try again.",
              })
            );
            return;
          }
          setStatus("starting_vm");
          await new Promise((r) => window.setTimeout(r, 1500));
          if (disposed) return;
          prepRes = await authedAxios.post<VmLoginPrepareResponse>(
            `${API_BASE}/sandbox/workspaces/${workspaceUuid}/provider-keys/vm-login/`,
            {
              provider,
              vm_uuid: prepData.vm_uuid,
              auto_start: false,
            }
          );
          prepData = prepRes.data;
          setVmName(prepData.vm_name || null);
        }
        if (disposed || !prepData.vm_uuid) return;

        const { sandbox_uuid: sandboxUuid, vm_uuid: vmUuid, login_command: loginCommand } = prepData;
        activeVmUuidRef.current = vmUuid;
        void fetchVMsRef.current(workspaceUuid);

        // Wait a tick for DialogContent to mount the terminal container.
        await new Promise((r) => window.setTimeout(r, 40));
        if (disposed || !terminalHostRef.current) return;

        setStatus("connecting");
        const term = new Terminal({
          cursorBlink: true,
          fontSize: 12.5,
          lineHeight: 1.3,
          fontFamily: "'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace",
          scrollback: 2000,
          theme: isLight
            ? { background: "#fafafa", foreground: "#18181b", cursor: "#18181b" }
            : { background: "#09090d", foreground: "#e4e4e7", cursor: "#ffffff" },
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(terminalHostRef.current);
        fitAddon.fit();
        term.focus();

        // Keep PTY dimensions synced whenever dialog layout or banner changes.
        resizeObserver = new ResizeObserver(() => {
          if (resizeTimer !== null) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            if (disposed || !terminalHostRef.current || terminalHostRef.current.clientWidth < 40) return;
            try {
              fitAddon.fit();
              const active = wsRef.current;
              if (active?.readyState === WebSocket.OPEN) {
                active.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
              }
            } catch {
              // Ignore transient resize errors while closing
            }
          }, 50);
        });
        resizeObserver.observe(terminalHostRef.current);

        // Allow clicking any http/https link directly inside the terminal canvas.
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const line = term.buffer.active.getLine(bufferLineNumber - 1);
            if (!line) {
              callback(undefined);
              return;
            }
            const text = line.translateToString(true);
            const links: Array<{
              range: { start: { x: number; y: number }; end: { x: number; y: number } };
              text: string;
              activate: () => void;
            }> = [];
            const re = /https?:\/\/[^\s"'<>)\]]+/g;
            let match: RegExpExecArray | null;
            while ((match = re.exec(text)) !== null) {
              const url = match[0];
              links.push({
                range: {
                  start: { x: match.index + 1, y: bufferLineNumber },
                  end: { x: match.index + url.length, y: bufferLineNumber },
                },
                text: url,
                activate: () => {
                  window.open(url, "_blank", "noopener,noreferrer");
                },
              });
            }
            callback(links);
          },
        });

        // Let Ctrl+V / Cmd+V trigger browser paste instead of sending Ctrl+V (\x16) to the PTY.
        term.attachCustomKeyEventHandler((event) => {
          if (event.type !== "keydown") return true;
          if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === "v") {
              return false;
            }
            if (key === "c" && term.hasSelection()) {
              event.preventDefault();
              void navigator.clipboard?.writeText(term.getSelection());
              return false;
            }
          }
          return true;
        });

        term.onData((data) => {
          const active = wsRef.current;
          if (active?.readyState === WebSocket.OPEN) {
            active.send(JSON.stringify({ type: "input", data }));
          }
        });

        termRef.current = term;
        fitAddonRef.current = fitAddon;

        const authToken = token || (typeof window !== "undefined" ? localStorage.getItem("token") : null) || "";
        const apiUrl = API_BASE || "http://localhost:8000";
        const wsBase = apiUrl.replace(/^http/, "ws");
        const decoder = new TextDecoder("utf-8");
        let autoRetries = 0;

        const clearTimers = () => {
          if (readyTimeout !== null) {
            window.clearTimeout(readyTimeout);
            readyTimeout = null;
          }
          if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
          }
        };

        const openSocket = async (): Promise<void> => {
          if (disposed) return;
          clearTimers();
          for (const sock of new Set([wsRef.current, controlWsRef.current])) {
            if (!sock) continue;
            sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
            try {
              sock.close(1000);
            } catch {
              // Ignore
            }
          }
          wsRef.current = null;
          controlWsRef.current = null;

          readyTimeout = window.setTimeout(() => {
            if (disposed) return;
            setStatus((cur) => {
              if (cur === "connecting") {
                setErrorText(
                  tRef.current("home.agentSelector.oauth.wsTimeout", {
                    defaultValue: "Terminal connection timed out. Click Retry to reconnect.",
                  })
                );
                return "error";
              }
              return cur;
            });
          }, 20000);

          const { data: ticketRes } = await authedAxios.post<{ ticket: string }>(
            `${apiUrl}/sandbox/sandboxes/${sandboxUuid}/terminal-ticket/`,
            {},
            { headers: { Authorization: `Bearer ${authToken}` } }
          );
          if (disposed) return;

          const tabId = `byos-login-${provider}-${Date.now()}`;
          const wsUrl = `${wsBase}/ws/sandbox/terminal/${sandboxUuid}/?tab_id=${encodeURIComponent(tabId)}&cols=${term.cols}&rows=${term.rows}${vmUuid ? `&vm_uuid=${encodeURIComponent(vmUuid)}` : ""}`;
          const socket = new WebSocket(wsUrl);
          wsRef.current = socket;
          controlWsRef.current = socket;

          let directSession: string | null = null;
          let challengeRequested = false;
          let proofSent = false;
          let serverErrorReported = false;
          let isReady = false;

          const isCurrent = (source: WebSocket) =>
            !disposed && (wsRef.current === source || controlWsRef.current === source);

          const handleClose = (source: WebSocket, event: CloseEvent) => {
            if (!isCurrent(source)) return;
            clearTimers();
            for (const peer of new Set([wsRef.current, controlWsRef.current])) {
              if (!peer || peer === source) continue;
              peer.onopen = peer.onmessage = peer.onerror = peer.onclose = null;
              try {
                peer.close();
              } catch {
                // Ignore
              }
            }
            controlWsRef.current = null;
            if (
              !isReady &&
              !serverErrorReported &&
              [1006, 4001, 4500].includes(event.code) &&
              autoRetries < 4
            ) {
              const delay = 800 * 2 ** autoRetries++;
              setStatus("connecting");
              retryTimer = window.setTimeout(() => {
                void openSocket().catch((err) => {
                  if (!disposed) {
                    setStatus("error");
                    setErrorText(
                      extractErrorMessage(
                        err,
                        tRef.current("home.agentSelector.oauth.startFailed", {
                          defaultValue: "Could not start VM terminal login.",
                        })
                      )
                    );
                  }
                });
              }, delay);
              return;
            }
            if (event.code === 1000 && isReady) return;
            setStatus("error");
            if (!serverErrorReported) {
              if (event.code === 4001) {
                setErrorText("Terminal session authentication expired. Please retry.");
              } else if (event.code === 4003) {
                setErrorText("You do not have permission to access this VM terminal.");
              } else if (event.code === 4004) {
                setErrorText("Workspace sandbox or VM was not found.");
              } else {
                setErrorText(`Terminal connection closed (code ${event.code || 1006}). Click Retry.`);
              }
            }
          };

          const handleMessage = (source: WebSocket, event: MessageEvent) => {
            if (!isCurrent(source)) return;
            if (event.data instanceof ArrayBuffer && source === wsRef.current && source !== controlWsRef.current) {
              const bytes = new Uint8Array(event.data);
              term.write(bytes);
              scanOutputChunk(decoder.decode(bytes, { stream: true }));
              return;
            }
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === "direct" && source === controlWsRef.current && wsRef.current === source) {
                directSession = msg.session;
                const direct = new WebSocket(msg.url);
                direct.binaryType = "arraybuffer";
                wsRef.current = direct;
                direct.onopen = () => {
                  if (!isCurrent(direct)) return;
                  direct.send(JSON.stringify({ type: "auth", ticket: msg.ticket }));
                };
                direct.onmessage = (e) => handleMessage(direct, e);
                direct.onclose = (e) => handleClose(direct, e);
                direct.onerror = () => {
                  // Wait for direct.onclose to either retry transient closes or report error.
                };
              } else if (msg.type === "challenge" && source === wsRef.current && directSession) {
                if (!challengeRequested && controlWsRef.current?.readyState === WebSocket.OPEN) {
                  challengeRequested = true;
                  controlWsRef.current.send(JSON.stringify({ type: "consume", challenge: msg.challenge }));
                }
              } else if (msg.type === "consumed" && source === controlWsRef.current) {
                if (challengeRequested && !proofSent && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: "proof", receipt: msg.receipt }));
                  proofSent = true;
                  controlWsRef.current = null;
                  source.onopen = source.onmessage = source.onerror = source.onclose = null;
                  source.close(1000);
                }
              } else if (msg.type === "ready" && source === wsRef.current) {
                isReady = true;
                clearTimers();
                setStatus("ready");
                fitAddon.fit();
                source.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                if (!commandDispatchedRef.current) {
                  commandDispatchedRef.current = true;
                  window.setTimeout(() => {
                    if (!disposed && source.readyState === WebSocket.OPEN) {
                      source.send(JSON.stringify({ type: "input", data: `${loginCommand}\n` }));
                    }
                  }, 150);
                }
              } else if (msg.type === "output" && msg.data) {
                term.write(msg.data);
                scanOutputChunk(String(msg.data));
              } else if (msg.type === "error") {
                serverErrorReported = true;
                clearTimers();
                setStatus("error");
                setErrorText(String(msg.data || "Terminal error."));
              }
            } catch {
              // Ignore non-JSON control messages
            }
          };

          socket.onopen = () => {
            if (!isCurrent(socket)) return;
            socket.send(JSON.stringify({ type: "auth", ticket: ticketRes.ticket }));
          };
          socket.onmessage = (e) => handleMessage(socket, e);
          socket.onclose = (e) => handleClose(socket, e);
          socket.onerror = () => {
            // Wait for socket.onclose to either retry or report failure cleanly.
          };
        };

        await openSocket();
      } catch (err) {
        if (!disposed) {
          setStatus("error");
          setErrorText(
            extractErrorMessage(
              err,
              tRef.current("home.agentSelector.oauth.startFailed", {
                defaultValue: "Could not start VM terminal login.",
              })
            )
          );
        }
      }
    };

    void startTerminal();
    return () => {
      disposed = true;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (readyTimeout !== null) window.clearTimeout(readyTimeout);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      resizeObserver?.disconnect();
      cleanupConnection();
    };
  }, [attemptNonce, cleanupConnection, createVmOnStart, isLight, open, provider, token, workspaceUuid]);

  // Poll sync-from-vm while the CLI login terminal is active so completion happens automatically.
  useEffect(() => {
    if (!open || status !== "ready" || !provider || !workspaceUuid) return;
    const timer = window.setInterval(() => {
      void syncFromVm(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [open, provider, status, syncFromVm, workspaceUuid]);

  if (!provider) return null;
  const meta = getProviderMeta(provider, t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-3 overflow-y-auto p-4 sm:p-5">
        <DialogHeader className="space-y-1">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
              {meta.logo}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {t("home.agentSelector.oauth.vmDialogTitle", {
                  agent: meta.name,
                  defaultValue: "Connect {{agent}} in your VM terminal",
                })}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {t("home.agentSelector.oauth.vmDialogSubtitle", {
                  defaultValue:
                    "Sign in directly using the official CLI inside your isolated Cloud VM. Click the generated login link to authorize.",
                })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {detectedUrl && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2.5">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-xs font-medium text-foreground">
                {t("home.agentSelector.oauth.linkReady", {
                  defaultValue: "Login link ready — click to authorize in your browser",
                })}
              </p>
              {detectedCode && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>One-time code:</span>
                  <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono font-semibold text-foreground">
                    {detectedCode}
                  </code>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(detectedCode);
                      setCopiedCode(true);
                      window.setTimeout(() => setCopiedCode(false), 1500);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] hover:text-foreground"
                  >
                    {copiedCode ? <LuCheck className="h-3 w-3 text-emerald-500" /> : <LuCopy className="h-3 w-3" />}
                  </button>
                </div>
              )}
            </div>
            <a
              href={detectedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
            >
              {t("home.agentSelector.oauth.openTab", { defaultValue: "Open Login Link" })}
              <LuExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        <div className="shrink-0 overflow-hidden rounded-xl border border-border/80 bg-[#09090d]">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5 font-mono">
              <LuTerminal className="h-3.5 w-3.5" />
              {vmName ? `Cloud VM · ${vmName}` : "Cloud VM PTY"}
            </span>
            <span className="flex items-center gap-1.5">
              {status !== "ready" && status !== "error" && status !== "needs_vm" && <LuLoader className="h-3 w-3 animate-spin" />}
              <span>
                {status === "preparing"
                  ? t("home.agentSelector.oauth.statusPreparing", { defaultValue: "Preparing VM..." })
                  : status === "needs_vm"
                    ? t("home.agentSelector.oauth.statusNeedsVm", { defaultValue: "No active VM" })
                    : status === "starting_vm"
                      ? t("home.agentSelector.oauth.statusStartingVm", { defaultValue: "Starting Cloud VM..." })
                      : status === "connecting"
                        ? t("home.agentSelector.oauth.statusConnecting", { defaultValue: "Connecting terminal..." })
                        : status === "ready"
                          ? t("home.agentSelector.oauth.statusReady", { defaultValue: "Interactive — click links or paste code directly" })
                          : t("home.agentSelector.oauth.statusError", { defaultValue: "Connection error" })}
              </span>
            </span>
          </div>
          {status === "needs_vm" ? (
            <div className="flex h-[clamp(180px,34dvh,250px)] min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center bg-background/95">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted/40">
                <LuServer className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="space-y-1 max-w-md">
                <p className="text-sm font-medium text-foreground">
                  {t("home.agentSelector.oauth.noVmTitle", { defaultValue: "No Cloud VM running in this workspace" })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("home.agentSelector.oauth.noVmDesc", {
                    minutes: defaultDurationMinutes,
                    defaultValue:
                      "Launch a {{minutes}}-minute VM so the official CLI can run inside your isolated environment and print your login link.",
                  })}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setErrorText(null);
                  setCreateVmOnStart(true);
                  setAttemptNonce((n) => n + 1);
                }}
                className="gap-1.5 text-xs"
              >
                <LuPlay className="h-3.5 w-3.5" />
                {t("home.agentSelector.oauth.launchVmButton", {
                  minutes: defaultDurationMinutes,
                  defaultValue: "Launch VM & Connect ({{minutes}}m)",
                })}
              </Button>
            </div>
          ) : (
            <div className="relative h-[clamp(180px,34dvh,250px)] min-h-[180px] w-full overflow-hidden">
              {(status === "preparing" || status === "starting_vm") && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#09090d]/90 px-4 text-center">
                  <LuLoader className="h-5 w-5 animate-spin text-muted-foreground" />
                  <p className="text-xs text-zinc-300">
                    {status === "starting_vm"
                      ? t("home.agentSelector.oauth.wakingVm", {
                          name: vmName || "Cloud VM",
                          defaultValue: "Starting {{name}} — terminal will open automatically once ready...",
                        })
                      : t("home.agentSelector.oauth.checkingVm", { defaultValue: "Checking workspace VM..." })}
                  </p>
                </div>
              )}
              <div
                onClick={() => termRef.current?.focus()}
                className="h-full w-full overflow-hidden px-3 py-2 cursor-text"
              >
                <div ref={terminalHostRef} className="h-full w-full" />
              </div>
            </div>
          )}
        </div>

        {status !== "needs_vm" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleVerifyAndConnect();
            }}
            className="space-y-1.5 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5"
          >
            <label htmlFor="vm-login-paste-code" className="text-xs font-medium text-foreground">
              {t("home.agentSelector.oauth.pasteCodeLabel", {
                defaultValue: "Paste the authorization code",
              })}
            </label>
            <p className="text-[11px] text-muted-foreground">
              {t("home.agentSelector.oauth.pasteCodeHint", {
                defaultValue: "After authorizing in your browser, copy the code shown on the page and paste it here.",
              })}
            </p>
            <Input
              id="vm-login-paste-code"
              value={pasteCode}
              onChange={(e) => setPasteCode(e.target.value)}
              disabled={status !== "ready" || isSyncing}
              autoComplete="off"
              spellCheck={false}
              placeholder={provider === "anthropic_sub" ? "code#state" : "code"}
              className="h-8 w-full font-mono text-xs"
            />
          </form>
        )}

        {errorText && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span className="min-w-0 flex-1">{errorText}</span>
            {status === "error" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setErrorText(null);
                  setAttemptNonce((n) => n + 1);
                }}
                className="h-7 shrink-0 px-2.5 text-[11px]"
              >
                {t("home.agentSelector.oauth.retryButton", { defaultValue: "Retry" })}
              </Button>
            )}
          </div>
        )}

        <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <LuShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
          <p className="min-w-0 flex-1">
            {t("home.agentSelector.oauth.vmDisclaimer", {
              agent: meta.name,
              defaultValue:
                "Your {{agent}} sign-in is stored encrypted so your Cloud VMs stay connected and removed when you disconnect. Neuron Runner is not affiliated with this provider; you are responsible for following their terms.",
            })}{" "}
            <a
              href="/terms-of-service#byok-mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {t("home.agentSelector.oauth.vmDisclaimerTerms", { defaultValue: "Terms of Service" })}
            </a>
          </p>
        </div>

        <div className="flex items-center justify-end pt-1">
          <Button
            type="button"
            size="sm"
            disabled={isSyncing || status === "preparing" || status === "starting_vm" || status === "needs_vm"}
            onClick={() => void handleVerifyAndConnect()}
            className="gap-1.5 text-xs"
          >
            {isSyncing ? <LuLoader className="h-3.5 w-3.5 animate-spin" /> : <LuRefreshCw className="h-3.5 w-3.5" />}
            {t("home.agentSelector.oauth.verifyButton", { defaultValue: "Verify & Connect" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
