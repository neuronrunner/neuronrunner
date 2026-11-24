import { API_BASE, authedAxios } from "@/lib/axios";
import { connectorError, type ConnectorServer } from "@/lib/connectors";

export const mcpOAuthStorageKey = (state: string) => `mcp-oauth:${state}`;
export const mcpOAuthChannel = (state: string) => `mcp-oauth-result:${state}`;
export interface MCPOAuthResult { source: "mcp-oauth"; state: string; server?: ConnectorServer; error?: string }

export async function connectMcpOAuth(server: ConnectorServer, popup: Window, options: { clientId?: string; clientSecret?: string; signal: AbortSignal }): Promise<ConnectorServer> {
  try {
    const { data } = await authedAxios.post<{ authorization_url: string; state: string; completion_secret: string; attempt_id: string }>(`${API_BASE}/mcp/${server.uuid}/oauth/start/`, {
      client_id: options.clientId || "", client_secret: options.clientSecret || "",
    }, { signal: options.signal });
    const destination = new URL(data.authorization_url);
    if (destination.protocol !== "https:" || destination.searchParams.get("state") !== data.state) throw new Error("The provider returned an invalid authorization URL.");
    const record = JSON.stringify({ completion_secret: data.completion_secret, serverId: server.uuid });
    // about:blank inherits our origin. Its session storage survives the provider round-trip.
    popup.sessionStorage.setItem(mcpOAuthStorageKey(data.state), record);
    return await new Promise<ConnectorServer>((resolve, reject) => {
      const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(mcpOAuthChannel(data.state));
      let settled = false;
      let checking = false;
      const started = Date.now();
      let timer: ReturnType<typeof setInterval>;
      const finish = (result?: ConnectorServer, error?: Error) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        options.signal.removeEventListener("abort", onAbort);
        channel?.close();
        clearInterval(timer);
        popup.close();
        if (error) reject(error); else resolve(result!);
      };
      const receive = (result: MCPOAuthResult) => {
        if (result?.source !== "mcp-oauth" || result.state !== data.state) return;
        if (result.server?.uuid === server.uuid && result.server.oauth_connected && result.server.enabled) finish(result.server);
        else if (result.error) finish(undefined, new Error(result.error));
      };
      const onMessage = (event: MessageEvent<MCPOAuthResult>) => {
        if (event.origin === window.location.origin && event.source === popup) receive(event.data);
      };
      const onAbort = () => finish(undefined, new DOMException("Authorization cancelled", "AbortError"));
      window.addEventListener("message", onMessage);
      if (channel) channel.onmessage = (event: MessageEvent<MCPOAuthResult>) => receive(event.data);
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) { onAbort(); return; }
      popup.location.href = destination.href;
      // Status polling also works when a provider's COOP policy severs window.opener.
      timer = setInterval(async () => {
        if (Date.now() - started >= 600000) { finish(undefined, new Error("Authorization expired. Connect your account again.")); return; }
        if (checking || settled) return;
        checking = true;
        try {
          const { data: status } = await authedAxios.get<{ status: string; server?: ConnectorServer }>(`${API_BASE}/mcp/${server.uuid}/oauth/status/`, { params: { attempt: data.attempt_id }, signal: options.signal });
          if (status.status === "connected" && status.server) finish(status.server);
          else if (status.status === "expired") finish(undefined, new Error("Authorization expired. Connect your account again."));
        } catch (error) {
          if (options.signal.aborted) onAbort();
          else if (Date.now() - started > 30000) finish(undefined, new Error(connectorError(error)));
        } finally { checking = false; }
      }, 2000);
    });
  } catch (error) { popup.close(); throw error; }
}
