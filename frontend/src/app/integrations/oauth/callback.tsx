import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LuCheck, LuLoader, LuPlug } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { API_BASE, authedAxios } from "@/lib/axios";
import { connectorError, type ConnectorServer } from "@/lib/connectors";
import { mcpOAuthChannel, mcpOAuthStorageKey, type MCPOAuthResult } from "@/lib/mcp-oauth";

export default function MCPOAuthCallback() {
  const { t } = useTranslation("connectors");
  const started = useRef(false);
  const [status, setStatus] = useState<"pending" | "connected" | "error">("pending");
  const [error, setError] = useState("");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state") || "";
    // Remove the short-lived code from history before making any further requests.
    window.history.replaceState(null, "", window.location.pathname);
    const notify = (result: MCPOAuthResult) => {
      if (window.opener) window.opener.postMessage(result, window.location.origin);
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(mcpOAuthChannel(state));
        channel.postMessage(result);
        channel.close();
      }
    };
    void (async () => {
      try {
        if (!state) throw new Error(t("oauth.errors.missingState"));
        const stored = sessionStorage.getItem(mcpOAuthStorageKey(state));
        if (!stored) throw new Error(t("oauth.errors.wrongTab"));
        sessionStorage.removeItem(mcpOAuthStorageKey(state));
        const pending = JSON.parse(stored) as { completion_secret: string; serverId: string };
        const { data } = await authedAxios.post<ConnectorServer>(`${API_BASE}/mcp/oauth/complete/`, {
          state, completion_secret: pending.completion_secret,
          code: params.get("code"), iss: params.get("iss"), error: params.get("error"),
        });
        if (data.uuid !== pending.serverId || !data.enabled || !data.oauth_connected) throw new Error(t("oauth.errors.unverified"));
        setStatus("connected");
        notify({ source: "mcp-oauth", state, server: data });
        window.setTimeout(() => window.close(), 300);
      } catch (cause) {
        const message = connectorError(cause);
        setError(message); setStatus("error");
        notify({ source: "mcp-oauth", state, error: message });
      }
    })();
  }, [t]);
  return <main className="flex h-full items-center justify-center bg-background p-6">
    <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
      <span className="mb-4 inline-flex rounded-lg bg-muted p-3">{status === "pending" ? <LuLoader className="h-5 w-5 animate-spin" /> : status === "connected" ? <LuCheck className="h-5 w-5 text-emerald-500" /> : <LuPlug className="h-5 w-5" />}</span>
      <h1 className="text-lg font-semibold">{status === "pending" ? t("oauth.status.pendingTitle") : status === "connected" ? t("oauth.status.connectedTitle") : t("oauth.status.errorTitle")}</h1>
      <p role={status === "error" ? "alert" : "status"} className="mt-3 text-sm leading-6 text-muted-foreground">{status === "pending" ? t("oauth.status.pendingDescription") : status === "connected" ? t("oauth.status.connectedDescription") : error}</p>
      {status !== "pending" && <Button asChild variant="outline" className="mt-5"><Link to="/integrations">{t("oauth.backToConnectors")}</Link></Button>}
    </div>
  </main>;
}
