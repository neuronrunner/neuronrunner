"use client";

import { env } from "@/lib/env";
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { LuTerminal, LuRefreshCw, LuEraser, LuPlus, LuX, LuChevronDown, LuEllipsis, LuCheck } from "react-icons/lu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import useWorkspaceTabsStore, { IWorkspaceTab } from "@/stores/workspace-tabs";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useAuthStore from "@/stores/auth";
import { cn } from "@/lib/utils";
import { authedAxios } from "@/lib/axios";

interface Props {
  tab: IWorkspaceTab;
  pane?: "left" | "right";
  isActive?: boolean;
  vmUuid?: string | null;
  vmConnected?: boolean;
  emptyState?: React.ReactNode;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

const getTermTheme = (isLight: boolean) =>
  isLight
    ? {
        background: "#ffffff",
        foreground: "#18181b",
        cursor: "#09090b",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(24, 24, 27, 0.15)",
        scrollbarSliderBackground: "rgba(100, 116, 139, 0.18)",
        scrollbarSliderHoverBackground: "rgba(100, 116, 139, 0.32)",
        scrollbarSliderActiveBackground: "rgba(100, 116, 139, 0.44)",
        overviewRulerBorder: "#00000000",
        black: "#09090b",
        red: "#dc2626",
        green: "#16a34a",
        yellow: "#d97706",
        blue: "#2563eb",
        magenta: "#9333ea",
        cyan: "#0891b2",
        white: "#71717a",
        brightBlack: "#a1a1aa",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#f59e0b",
        brightBlue: "#3b82f6",
        brightMagenta: "#a855f7",
        brightCyan: "#06b6d4",
        brightWhite: "#18181b",
      }
    : {
        background: "#050508",
        foreground: "#e4e4e7",
        cursor: "#ffffff",
        cursorAccent: "#050508",
        selectionBackground: "rgba(244, 244, 245, 0.2)",
        scrollbarSliderBackground: "rgba(146, 146, 157, 0.18)",
        scrollbarSliderHoverBackground: "rgba(146, 146, 157, 0.32)",
        scrollbarSliderActiveBackground: "rgba(146, 146, 157, 0.44)",
        overviewRulerBorder: "#00000000",
        black: "#18181b",
        red: "#ef4444",
        green: "#10b981",
        yellow: "#f59e0b",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#f4f4f5",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#34d399",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      };

const EMPTY_TABS: IWorkspaceTab[] = [];

export const TerminalTabView = React.memo<Props>(function TerminalTabView({ tab, pane = "right", isActive = true, vmUuid = null, vmConnected = true, emptyState }) {
  const { t } = useTranslation("workspace");
  const { theme, resolvedTheme } = useTheme();
  const isLight =
    resolvedTheme === "light" ||
    (resolvedTheme !== "dark" && (theme === "light" || (typeof document !== "undefined" && document.documentElement.classList.contains("light"))));
  const token = useAuthStore((state) => state.token);
  const sandboxUuid = useSandboxProjectsStore((state) => state.currentSandbox?.uuid || state.workspaceSandbox?.uuid);
  const terminalTabs = useWorkspaceTabsStore((state) => isActive ? (pane === "right" ? state.splitTabs : state.tabs) : EMPTY_TABS).filter((t) => t.type === "terminal");
  const setActiveSplitTab = useWorkspaceTabsStore((state) => state.setActiveSplitTab);
  const setActiveTab = useWorkspaceTabsStore((state) => state.setActiveTab);
  const openTerminalTab = useWorkspaceTabsStore((state) => state.openTerminalTab);
  const closeTab = useWorkspaceTabsStore((state) => state.closeTab);
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const themeRef = useRef(isLight);
  themeRef.current = isLight;


  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const connectionAttemptRef = useRef(0);
  const controlSocketRef = useRef<WebSocket | null>(null);
  const selectedSessionRef = useRef<HTMLDivElement>(null);
  const focusAfterActionRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const automaticRetriesRef = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!pickerOpen) return;
    const frame = requestAnimationFrame(() => selectedSessionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [pickerOpen]);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const connectionStatusRef = useRef<ConnectionStatus>("connecting");
  const updateStatus = useCallback((next: ConnectionStatus) => {
    connectionStatusRef.current = next;
    setStatus(next);
  }, []);

  // Dynamic theme update without reconnecting socket
  useEffect(() => {
    if (termInstanceRef.current?.options) {
      termInstanceRef.current.options.theme = getTermTheme(isLight);
      try {
        termInstanceRef.current.refresh?.(0, termInstanceRef.current.rows - 1);
      } catch {
        // ignore
      }
    }
  }, [isLight]);

  const disconnectSocket = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    connectionAttemptRef.current += 1;
    const sockets = new Set([wsRef.current, controlSocketRef.current]);
    wsRef.current = null;
    controlSocketRef.current = null;
    for (const socket of sockets) {
      if (!socket) continue;
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
  }, []);

  const disconnectTerminal = useCallback(() => {
    disconnectSocket();
    termInstanceRef.current?.dispose();
    termInstanceRef.current = null;
    fitAddonRef.current = null;
  }, [disconnectSocket]);

  const connectTerminal = useCallback(async (automatic = false): Promise<void> => {
    if (!terminalRef.current) return;
    if (!automatic) automaticRetriesRef.current = 0;
    disconnectSocket();
    if (!vmConnected) {
      updateStatus("disconnected");
      return;
    }
    const connectionAttempt = connectionAttemptRef.current;
    updateStatus("connecting");

    // Keep the terminal buffer and scrollback when replacing the connection.
    let term = termInstanceRef.current;
    if (!term) {
      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        cursorInactiveStyle: "block",
        fontSize: 13,
        lineHeight: 1.3,
        fontFamily:
          'ui-monospace, SFMono-Regular, "Cascadia Code", "Liberation Mono", Menlo, Monaco, Consolas, monospace',
        theme: getTermTheme(themeRef.current),
        scrollback: 5000,
        overviewRuler: { width: 6 },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);
      termInstanceRef.current = term;
      fitAddonRef.current = fitAddon;
      if (term.options) {
        term.options.theme = getTermTheme(themeRef.current);
      }

      // Register once; input always goes to the current socket.
      term.onData((data) => {
        const socket = wsRef.current;
        if (connectionStatusRef.current === "connected" && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", data }));
        }
      });
    }

    const fitAndFocus = () => {
      if (!activeRef.current || termInstanceRef.current !== term || !terminalRef.current?.clientWidth) return;
      try {
        fitAddonRef.current?.fit();
        if (!document.activeElement?.closest('[role="menu"]')) term.focus();
      } catch {
        // ignore
      }
    };

    // Register before fetching a ticket so failed startup can also be retried.
    // Consume the reconnect key instead of sending it to the new shell.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (termInstanceRef.current !== term) return false;
      if (connectionStatusRef.current === "error" || connectionStatusRef.current === "disconnected") {
        event.preventDefault();
        if (!event.repeat) void connectTerminal();
        return false;
      }
      return connectionStatusRef.current === "connected";
    });

    let reconnectPromptShown = false;
    const showReconnectPrompt = () => {
      if (reconnectPromptShown) return;
      reconnectPromptShown = true;
      term.writeln(`\r\n\x1b[33m${t("terminalView.pressAnyKey")}\x1b[0m`);
    };

    // Ensure fonts are loaded before measuring character metrics
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.ready.then(fitAndFocus);
    }
    requestAnimationFrame(fitAndFocus);

    const authToken = token || (typeof window !== "undefined" ? localStorage.getItem("token") : null);

    if (!sandboxUuid) {
      term.writeln(`\x1b[33m${t("terminalView.connectingTag")}\x1b[0m ${t("terminalView.initializingSandbox")}`);
      const store = useSandboxProjectsStore.getState();
      if (!store.workspaceSandbox) {
        void store.fetchSandboxes();
      }
      return;
    }

    const apiUrl = env.API_URL || "http://localhost:8000";
    const wsBase = apiUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase}/ws/sandbox/terminal/${sandboxUuid}/?tab_id=${encodeURIComponent(tab.id)}&cols=${term.cols}&rows=${term.rows}${vmUuid ? `&vm_uuid=${encodeURIComponent(vmUuid)}` : ""}`;

    try {
      const { data } = await authedAxios.post(`${apiUrl}/sandbox/sandboxes/${sandboxUuid}/terminal-ticket/`, {}, {
        headers: { Authorization: `Bearer ${authToken || ""}` },
      });
      if (termInstanceRef.current !== term || connectionAttemptRef.current !== connectionAttempt) return;
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      controlSocketRef.current = socket;
      let serverErrorReported = false;
      let directSession: string | null = null;
      let challengeRequested = false;
      let proofSent = false;
      const isCurrent = (source: WebSocket) => connectionAttemptRef.current === connectionAttempt
        && (wsRef.current === source || controlSocketRef.current === source);

      socket.onopen = () => {
        if (wsRef.current !== socket) return;
        socket.send(JSON.stringify({ type: "auth", ticket: data.ticket }));
      };

      const onMessage = (source: WebSocket, event: MessageEvent) => {
        if (!isCurrent(source)) return;
        if (event.data instanceof ArrayBuffer && source === wsRef.current && source !== controlSocketRef.current) {
          if (connectionStatusRef.current === "connected") term.write(new Uint8Array(event.data));
          return;
        }
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "direct" && source === controlSocketRef.current && wsRef.current === source) {
            const directUrl = new URL(msg.url);
            if (directUrl.protocol !== "wss:" || directUrl.search || directUrl.hash || directUrl.username || directUrl.password
              || typeof msg.session !== "string" || !msg.session || typeof msg.ticket !== "string") {
              throw new Error(t("terminalView.invalidDirectAddress"));
            }
            directSession = msg.session;
            const direct = new WebSocket(directUrl.toString());
            direct.binaryType = "arraybuffer";
            wsRef.current = direct;
            direct.onopen = () => {
              if (!isCurrent(direct)) return;
              direct.send(JSON.stringify({ type: "auth", ticket: msg.ticket }));
            };
            direct.onmessage = event => onMessage(direct, event);
            direct.onerror = () => onError(direct);
            direct.onclose = event => onClose(direct, event);
          } else if (msg.type === "challenge" && source === wsRef.current && directSession) {
            if (challengeRequested || msg.session !== directSession || !/^[A-Za-z0-9_-]{43}$/.test(msg.challenge)
              || controlSocketRef.current?.readyState !== WebSocket.OPEN) throw new Error(t("terminalView.invalidVmChallenge"));
            challengeRequested = true;
            controlSocketRef.current.send(JSON.stringify({ type: "consume", challenge: msg.challenge }));
          } else if (msg.type === "consumed" && source === controlSocketRef.current) {
            if (!challengeRequested || proofSent || msg.session !== directSession || typeof msg.receipt !== "string"
              || wsRef.current?.readyState !== WebSocket.OPEN) throw new Error(t("terminalView.invalidReceipt"));
            wsRef.current.send(JSON.stringify({ type: "proof", receipt: msg.receipt }));
            proofSent = true;
            // Authentication is complete. No persistent backend connection or
            // authorization lease is needed for the direct terminal data path.
            controlSocketRef.current = null;
            source.onopen = source.onmessage = source.onerror = source.onclose = null;
            source.close(1000);
          } else if (msg.type === "ready" && source === wsRef.current) {
            if (directSession && !proofSent) throw new Error(t("terminalView.readyBeforeAuth"));
            automaticRetriesRef.current = 0;
            updateStatus("connected");
            if (activeRef.current) fitAndFocus();
            source.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          } else if (msg.type === "output" && msg.data) {
            term.write(msg.data);
          } else if (msg.type === "error") {
            serverErrorReported = true;
            term.writeln(`\r\n\x1b[31m${t("terminalView.errorTag")} ${msg.data}\x1b[0m`);
            updateStatus("error");
            showReconnectPrompt();
          }
        } catch {
          serverErrorReported = true;
          onError(source);
          source.close(4400);
        }
      };

      const onError = (source: WebSocket) => {
        if (!isCurrent(source)) return;
        if (directSession && !serverErrorReported && automaticRetriesRef.current < 5) return;
        updateStatus("error");
        showReconnectPrompt();
      };

      const onClose = (source: WebSocket, event: CloseEvent) => {
        if (!isCurrent(source)) return;
        // Any startup failure also releases its companion connection.
        for (const peer of new Set([wsRef.current, controlSocketRef.current])) {
          if (!peer || peer === source) continue;
          peer.onopen = peer.onmessage = peer.onerror = peer.onclose = null;
          peer.close();
        }
        controlSocketRef.current = null;
        const willAutoRetry = Boolean(
          directSession && !serverErrorReported && [1006, 4001, 4500].includes(event.code)
          && automaticRetriesRef.current < 5
        );
        if (willAutoRetry) {
          updateStatus("connecting");
          const delay = 1000 * 2 ** automaticRetriesRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            if (connectionAttemptRef.current === connectionAttempt) void connectTerminal(true);
          }, delay);
          return;
        }
        updateStatus(serverErrorReported ? "error" : "disconnected");
        if (event.code === 4001) {
          term.writeln(`\r\n\x1b[31m${t("terminalView.authErrorTag")} ${t("terminalView.authError")}\x1b[0m`);
        } else if (event.code === 4003) {
          term.writeln(`\r\n\x1b[31m${t("terminalView.permissionErrorTag")} ${t("terminalView.permissionError")}\x1b[0m`);
        } else if (event.code === 4004) {
          term.writeln(`\r\n\x1b[31m${t("terminalView.errorTag")} ${t("terminalView.sandboxNotFound")}\x1b[0m`);
        } else if (!serverErrorReported && event.code !== 1000 && event.code !== 1005) {
          term.writeln(`\r\n\x1b[33m${t("terminalView.disconnectedTag")} ${t("terminalView.sessionClosed", { code: event.code })}\x1b[0m`);
        }
        showReconnectPrompt();
      };
      socket.onmessage = event => onMessage(socket, event);
      socket.onerror = () => onError(socket);
      socket.onclose = event => onClose(socket, event);
    } catch (err: any) {
      if (termInstanceRef.current !== term || connectionAttemptRef.current !== connectionAttempt) return;
      console.error("Failed to initialize WebSocket:", err);
      updateStatus("error");
      term.writeln(`\r\n\x1b[31m${t("terminalView.errorTag")} ${err?.message || t("terminalView.startConnectionFailed")}\x1b[0m`);
      showReconnectPrompt();
    }
  }, [sandboxUuid, token, tab.id, vmUuid, vmConnected, disconnectSocket, updateStatus, t]);

  useEffect(() => {
    if (activeRef.current) connectTerminal();
    return disconnectTerminal;
  }, [connectTerminal, disconnectTerminal]);

  // When tab becomes active, trigger fit and focus
  useEffect(() => {
    if (isActive) {
      if (!termInstanceRef.current) connectTerminal();
      const timer = setTimeout(() => {
        const el = terminalRef.current;
        if (!el || el.offsetParent === null || el.clientWidth < 50) return;
        if (fitAddonRef.current && termInstanceRef.current) {
          try {
            fitAddonRef.current.fit();
            if (!document.activeElement?.closest('[role="menu"]')) termInstanceRef.current.focus();
            if (connectionStatusRef.current === "connected" && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({
                  type: "resize",
                  cols: termInstanceRef.current.cols,
                  rows: termInstanceRef.current.rows,
                })
              );
            }
          } catch {
            // ignore
          }
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive, connectTerminal, terminalTabs.length]);

  // Handle auto-fitting when pane size changes
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;

    let resizeTimer: any = null;

    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const targetEl = terminalRef.current;
        if (!activeRef.current || !targetEl || targetEl.offsetParent === null || targetEl.clientWidth < 50) return;
        if (fitAddonRef.current && termInstanceRef.current) {
          try {
            fitAddonRef.current.fit();
            if (connectionStatusRef.current === "connected" && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({
                  type: "resize",
                  cols: termInstanceRef.current.cols,
                  rows: termInstanceRef.current.rows,
                })
              );
            }
          } catch {
            // ignore
          }
        }
      }, 50);
    });

    observer.observe(el);
    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
    };
  }, []);

  const handleClear = () => {
    termInstanceRef.current?.clear();
    termInstanceRef.current?.focus();
  };

  const handleNewTerminalTab = () => {
    openTerminalTab(undefined, pane);
  };

  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col w-full h-full min-h-0 select-none",
        isLight ? "bg-white text-zinc-900" : "bg-[#050508] text-zinc-200"
      )}
      onClick={() => termInstanceRef.current?.focus()}
    >
      {isActive && (
        <div
          data-terminal-toolbar
          className="workspace-tool-header workspace-tool-toolbar select-none"
          onClick={(event) => event.stopPropagation()}
        >
          <DropdownMenu modal={false} open={pickerOpen} onOpenChange={setPickerOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("terminalView.selectTerminal")}
                title={t("terminalView.selectTerminal")}
                className="workspace-tool-field group flex-1 text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground data-[state=open]:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <LuTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono">{tab.title || t("common.terminal")}</span>
                <LuChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-180" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={6}
              className="w-64 max-w-[calc(100vw-1rem)] rounded-lg p-1 shadow-lg"
            >
              <div className="flex items-center justify-between px-2.5 py-2 text-[11px] text-muted-foreground">
                <span>{t("terminalView.terminals")}</span>
                <span className="tabular-nums">{terminalTabs.length}</span>
              </div>
              <div className="max-h-64 overflow-y-auto overscroll-contain">
                {terminalTabs.map((terminal, index) => {
                  const isCurrent = terminal.id === tab.id;
                  const title = terminal.title || t("terminalView.terminalNumber", { number: index + 1 });
                  return (
                    <DropdownMenuItem
                      key={terminal.id}
                      ref={isCurrent ? selectedSessionRef : undefined}
                      aria-label={title}
                      aria-current={isCurrent ? "true" : undefined}
                      onSelect={() => {
                        if (pane === "right") setActiveSplitTab(terminal.id);
                        else setActiveTab(terminal.id);
                      }}
                      className={cn(
                        "group/terminal flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-xs",
                        isCurrent && "bg-muted/70 text-foreground"
                      )}
                    >
                      <LuTerminal className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono">{title}</span>
                      {isCurrent && <LuCheck className="text-muted-foreground" />}
                      <button
                        type="button"
                        title={t("terminalView.closeTerminalNamed", { title })}
                        aria-label={t("terminalView.closeTerminalNamed", { title })}
                        onPointerDown={(event) => event.stopPropagation()}
                        // Keep the menu from synthesizing a selection click on pointer-up.
                        onPointerUp={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          closeTab(terminal.id);
                        }}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <LuX className="h-3 w-3" />
                      </button>
                    </DropdownMenuItem>
                  );
                })}
              </div>
              <DropdownMenuSeparator className="mx-1" />
              <DropdownMenuItem onSelect={handleNewTerminalTab} className="rounded-md px-2.5 py-2 text-xs">
                <LuPlus className="text-muted-foreground" />
                {t("terminalView.newTerminal")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t("terminalView.controlsAria")}>
            <span role="status" title={t("terminalView.statusTitle", { status: t(`terminalView.status.${status}`) })} className="flex h-7 w-5 items-center justify-center">
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  status === "connected" && "bg-emerald-500",
                  status === "connecting" && "bg-amber-500 motion-safe:animate-pulse",
                  (status === "disconnected" || status === "error") && "bg-rose-500"
                )}
              />
              <span className="sr-only">
                {t(`terminalView.status.${status}`)}
              </span>
            </span>
            <button
              type="button"
              onClick={handleNewTerminalTab}
              title={t("terminalView.openNewTerminal")}
              aria-label={t("terminalView.newTerminalAria")}
              className="workspace-tool-icon-button"
            >
              <LuPlus className="h-4 w-4" />
            </button>
            <DropdownMenu modal={false} onOpenChange={(open) => { if (open) focusAfterActionRef.current = false; }}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={t("terminalView.actions")}
                  aria-label={t("terminalView.actions")}
                  className="workspace-tool-icon-button data-[state=open]:bg-muted/60 data-[state=open]:text-foreground"
                >
                  <LuEllipsis className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={6}
                className="w-48 rounded-lg p-1 shadow-lg"
                onCloseAutoFocus={(event) => {
                  if (focusAfterActionRef.current) {
                    event.preventDefault();
                    focusAfterActionRef.current = false;
                    termInstanceRef.current?.focus();
                  }
                }}
              >
                <DropdownMenuItem onSelect={() => { focusAfterActionRef.current = true; connectTerminal(); }} title={t("terminalView.reconnect")} className="rounded-md px-2.5 py-2 text-xs">
                  <LuRefreshCw className="text-muted-foreground" />
                  {t("terminalView.reconnect")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { focusAfterActionRef.current = true; handleClear(); }} title={t("terminalView.clearScreenTitle")} className="rounded-md px-2.5 py-2 text-xs">
                  <LuEraser className="text-muted-foreground" />
                  {t("terminalView.clearScreen")}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="mx-1" />
                <DropdownMenuItem
                  onSelect={() => closeTab(tab.id)}
                  title={t("terminalView.closeTerminal")}
                  className="rounded-md px-2.5 py-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <LuX />
                  {t("terminalView.closeTerminal")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {/* Terminal Viewport */}
      {!vmConnected && emptyState && (
        <div
          className="absolute inset-x-0 bottom-0 top-10 z-10 flex items-center justify-center bg-background"
          onClick={(event) => event.stopPropagation()}
        >
          {emptyState}
        </div>
      )}
      <div
        ref={terminalRef}
        className={cn(
          "flex-1 w-full min-h-0 pl-3 pr-2 pt-2 pb-2 overflow-hidden cursor-text",
          isLight ? "bg-white" : "bg-[#050508]"
        )}
      />
    </div>
  );
});

export default TerminalTabView;
