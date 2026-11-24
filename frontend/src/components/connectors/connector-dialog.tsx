"use client";

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LuArrowUpRight, LuCheck, LuLoader, LuPlug, LuShieldCheck, LuTrash2 } from "react-icons/lu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConnectorIcon } from "./connector-icon";
import { API_BASE, authedAxios } from "@/lib/axios";
import { connectorCanConnect, connectorCategoryLabel, connectorError, connectorRemotes, connectorRemoteSuffix, connectorServerName, type Connector, type ConnectorServer } from "@/lib/connectors";
import { connectMcpOAuth } from "@/lib/mcp-oauth";
import useAuthStore from "@/stores/auth";
import useSigninStore from "@/stores/signin";

const fieldClass = "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function ConnectorDialog({ connector, server, onClose, onCustom, onSaved, onRemoved }: {
  connector: Connector | null;
  server?: ConnectorServer;
  onClose: () => void;
  onCustom?: () => void;
  onSaved: (server: ConnectorServer) => void;
  onRemoved: (uuid: string) => void;
}) {
  const { t } = useTranslation("connectors");
  const token = useAuthStore((state) => state.token);
  const setupOnly = Boolean(connector && !connectorCanConnect(connector) && !server);
  const remotes = connector ? connectorRemotes(connector) : [];
  const initialRemoteIndex = server?.url
    ? Math.max(0, remotes.findIndex((item) => item.url === server.url))
    : 0;
  const [saved, setSaved] = useState(server);
  const [method, setMethod] = useState(`remote:${initialRemoteIndex}`);
  const [name, setName] = useState(server?.name || "");
  const remote = remotes[Number(method.split(":")[1])];
  const [url, setUrl] = useState(server?.url || remote?.url || "");
  const [authMethod, setAuthMethod] = useState<"oauth" | "token" | "none">(
    server
      ? server.auth_type === "oauth"
        ? "oauth"
        : server.has_headers
          ? "token"
          : remotes[initialRemoteIndex]?.authentication === "token"
            ? "token"
            : "none"
      : remotes[initialRemoteIndex]?.authentication || "oauth"
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const oauthAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { oauthAbort.current?.abort(); }, []);
  const [httpTransport, setHttpTransport] = useState(server?.http_transport || remote?.type || "streamable-http");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [extraSettings, setExtraSettings] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [toolCount, setToolCount] = useState(0);
  const isLegacy = saved?.transport === "stdio";
  const isOAuth = authMethod === "oauth";
  const credentialFields = authMethod !== "token" ? [] : remote?.headers?.length ? remote.headers : [{ name: "Authorization", description: t("dialog.authHeaderDescription"), isSecret: true }];

  const changeMethod = (value: string) => {
    setMethod(value);
    const nextRemote = remotes[Number(value.split(":")[1])];
    setUrl(nextRemote?.url || "");
    setHttpTransport(nextRemote?.type || "streamable-http");
    setAuthMethod(nextRemote?.authentication || "oauth");
    setCredentials({}); setExtraSettings(""); setError(""); setVerified(false);
  };

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token) { useSigninStore.getState().setOpen(true); return; }
    setBusy(true); setError(""); setVerified(false);
    const popup = isOAuth ? window.open("about:blank", "neuronrunner_mcp_oauth", "width=580,height=760") : null;
    try {
      if (isOAuth && !popup) throw new Error(t("dialog.errors.allowPopups"));
      let settings: Record<string, string> = {};
      if (extraSettings.trim()) {
        const parsed: unknown = JSON.parse(extraSettings);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error(t("dialog.errors.invalidJsonObject"));
        settings = parsed as Record<string, string>;
      }
      for (const input of credentialFields) {
        if (!input.name) continue;
        const value = credentials[input.name]?.trim() || (!saved ? input.default || "" : "");
        if (value) settings[input.name] = value;
        if (input.isRequired && !value && !settings[input.name] && !(saved && saved.has_headers)) throw new Error(t("dialog.errors.fieldRequired", { name: input.name }));
      }
      if (/[{}<>]/.test(url)) throw new Error(t("dialog.errors.urlPlaceholders"));
      const payload = {
        name: connector ? connectorServerName(connector) : name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100),
        transport: "http",
        http_transport: httpTransport,
        url: url.trim(),
        command: "",
        workspace: null,
        auth_type: isOAuth ? "oauth" : "manual",
        enabled: false,
        ...(authMethod === "none" ? { headers_json: {} } : Object.keys(settings).length || !saved ? { headers_json: settings } : {}),
      };
      const response = saved ? await authedAxios.patch<ConnectorServer>(`${API_BASE}/mcp/${saved.uuid}/`, payload) : await authedAxios.post<ConnectorServer>(`${API_BASE}/mcp/`, payload);
      let next = response.data;
      setSaved(next); onSaved(next);
      if (isOAuth && popup) {
        oauthAbort.current = new AbortController();
        next = await connectMcpOAuth(next, popup, { clientId, clientSecret, signal: oauthAbort.current.signal });
        setSaved(next); onSaved(next); setToolCount(next.tools.length); setVerified(true);
        return;
      }
      const test = await authedAxios.post<{ success: boolean; tool_count: number }>(`${API_BASE}/mcp/${next.uuid}/test/`);
      if (!test.data.success) throw new Error(t("dialog.errors.verificationFailed"));
      // Activation follows a successful handshake; a saved configuration alone is not connected.
      next = (await authedAxios.patch<ConnectorServer>(`${API_BASE}/mcp/${next.uuid}/`, { enabled: true })).data;
      setSaved(next); onSaved(next); setToolCount(test.data.tool_count); setVerified(true);
    } catch (cause) {
      popup?.close();
      setError(cause instanceof SyntaxError ? t("dialog.errors.invalidAdvancedJson") : connectorError(cause));
    } finally { oauthAbort.current = null; setBusy(false); }
  };

  const disconnect = async () => {
    if (!saved) return;
    setBusy(true); setError("");
    try { await authedAxios.delete(`${API_BASE}/mcp/${saved.uuid}/`); onRemoved(saved.uuid); onClose(); }
    catch (cause) { setError(connectorError(cause)); }
    finally { setBusy(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="connectors-dialog max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl p-6">
      <DialogHeader className="text-left">
        <ConnectorIcon connector={connector || undefined} className="mb-3 h-14 w-14 rounded-2xl" />
        <DialogTitle className="text-xl tracking-tight">{connector?.name || (server ? server.name : t("dialog.customTitle"))}</DialogTitle>
        <DialogDescription className="pt-1 text-[13px] leading-relaxed">{connector?.description || t("dialog.customDescription")}</DialogDescription>
      </DialogHeader>
      {connector && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="rounded-full bg-muted px-2.5 py-1">{connectorCategoryLabel(connector.category)}</span>{connector.version !== "directory" && <span>v{connector.version}</span>}<a href={connector.website} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 hover:text-foreground">{t("dialog.setupGuide")}<LuArrowUpRight className="h-3.5 w-3.5" /></a></div>}
      {setupOnly && connector ? <div className="space-y-4 rounded-xl border border-border bg-muted p-5">
        <h3 className="text-sm font-medium">{t("dialog.providerSetup.title")}</h3>
        <p className="text-[13px] leading-6 text-muted-foreground">{t("dialog.providerSetup.description")}</p>
        <div className="flex flex-wrap gap-2"><Button asChild className="rounded-lg text-xs"><a href={connector.website} target="_blank" rel="noopener noreferrer">{t("dialog.providerSetup.visitProvider")}<LuArrowUpRight className="h-3.5 w-3.5" /></a></Button>{onCustom && <Button variant="outline" onClick={onCustom} className="rounded-lg text-xs">{t("dialog.providerSetup.addEndpoint")}<LuPlug className="h-3.5 w-3.5" /></Button>}</div>
      </div> : isLegacy ? <div className="space-y-4 rounded-xl border border-border bg-muted p-5">
        <h3 className="text-sm font-medium">{t("dialog.legacyLocal.title")}</h3>
        <p className="text-[13px] leading-6 text-muted-foreground">{t("dialog.legacyLocal.description")}</p>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={disconnect} className="text-destructive"><LuTrash2 className="h-3.5 w-3.5" />{t("dialog.actions.disconnect")}</Button>
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      </div> : verified ? <div className="space-y-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5"><div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400"><LuCheck className="h-5 w-5" /><h3 className="font-medium">{t("dialog.verified.title")}</h3></div><p className="text-sm text-muted-foreground">{toolCount === 1 ? t("dialog.verified.descriptionOne", { count: toolCount }) : t("dialog.verified.descriptionOther", { count: toolCount })}</p><Button onClick={onClose} className="w-full rounded-lg">{t("dialog.verified.done")}</Button></div> : <form onSubmit={connect} className="space-y-4">
        {!connector && <label className="block space-y-1.5 text-xs font-medium">{t("dialog.fields.name")}<input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} pattern=".*[a-zA-Z0-9].*" placeholder={t("dialog.fields.namePlaceholder")} /></label>}
        <div className="space-y-1.5">
          <label htmlFor="connector-method" className="text-xs font-medium">{t("dialog.fields.connectionMethod")}</label>
          <Select name="connection-method" value={method} onValueChange={changeMethod} disabled={busy}>
            <SelectTrigger id="connector-method" className={`${fieldClass} font-normal shadow-none`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {connector ? remotes.map((item, index) => <SelectItem key={`remote:${index}`} value={`remote:${index}`}>{t("dialog.methods.remote", { protocol: item.type === "sse" ? "SSE" : "Streamable HTTP", suffix: connectorRemoteSuffix(item, index, remotes) })}</SelectItem>) : <SelectItem value="remote:0">{t("dialog.methods.remoteHttp")}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <label className="block space-y-1.5 text-xs font-medium">{t("dialog.fields.serverUrl")}<input type="url" required readOnly={Boolean(connector)} value={url} onChange={(event) => { if (!connector) setUrl(event.target.value); }} className={`${fieldClass} font-mono text-xs${connector ? " bg-muted/50 text-muted-foreground" : ""}`} placeholder="https://your-server.com/mcp" /></label>
        {!connector && <div className="space-y-1.5">
          <label htmlFor="connector-http-protocol" className="text-xs font-medium">{t("dialog.fields.httpProtocol")}</label>
          <Select name="http-protocol" value={httpTransport} onValueChange={(value) => setHttpTransport(value as typeof httpTransport)} disabled={busy}>
            <SelectTrigger id="connector-http-protocol" className={`${fieldClass} font-normal shadow-none`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="streamable-http">Streamable HTTP</SelectItem><SelectItem value="sse">SSE</SelectItem></SelectContent>
          </Select>
        </div>}
        <div className="space-y-1.5">
          <label htmlFor="connector-auth" className="text-xs font-medium">{t("dialog.fields.authentication")}</label>
          <Select value={authMethod} onValueChange={(value) => { setAuthMethod(value as typeof authMethod); setCredentials({}); setExtraSettings(""); setError(""); }} disabled={busy}>
            <SelectTrigger id="connector-auth" className={`${fieldClass} font-normal shadow-none`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="oauth">{t("dialog.auth.oauth")}</SelectItem><SelectItem value="token">{t("dialog.auth.token")}</SelectItem><SelectItem value="none">{t("dialog.auth.none")}</SelectItem></SelectContent>
          </Select>
        </div>
        {isOAuth && <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
          <p className="text-xs leading-5 text-muted-foreground">{t("dialog.oauth.description")}</p>
          <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t("dialog.oauth.settings")}</summary><div className="mt-3 space-y-3">
            <p className="text-[11px] leading-5 text-muted-foreground">{t("dialog.oauth.settingsHint")}</p>
            <label className="block space-y-1.5">{t("dialog.oauth.clientId")}<input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" className={fieldClass} /></label>
            <label className="block space-y-1.5">{t("dialog.oauth.clientSecret")}<input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" className={fieldClass} /></label>
            <label className="block space-y-1.5">{t("dialog.oauth.redirectUrl")}<input readOnly value={`${window.location.origin}/integrations/oauth/callback`} className={`${fieldClass} text-xs`} /></label>
          </div></details>
        </div>}
        {credentialFields.filter((field) => field.name).map((field) => <label key={field.name} className="block space-y-1.5 text-xs font-medium">{field.name}{field.isRequired && <span className="text-muted-foreground"> · {t("dialog.fields.required")}</span>}<input type={field.isSecret || field.name === "Authorization" ? "password" : "text"} autoComplete="off" spellCheck={false} value={credentials[field.name!] ?? ""} onChange={(event) => setCredentials((values) => ({ ...values, [field.name!]: event.target.value }))} placeholder={saved ? t("dialog.fields.keepSavedPlaceholder") : field.default || (field.name === "Authorization" ? "Bearer your-access-token" : t("dialog.fields.enterFieldPlaceholder", { name: field.name }))} className={fieldClass} /><span className="block text-[11px] font-normal leading-relaxed text-muted-foreground">{field.description}</span></label>)}
        {authMethod === "token" && <details className="rounded-lg border border-border px-3 py-2.5 text-xs"><summary className="cursor-pointer text-muted-foreground">{t("dialog.advanced.headersSummary")}</summary><p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t("dialog.advanced.description")}</p><textarea aria-label={t("dialog.advanced.ariaLabel")} value={extraSettings} onChange={(event) => setExtraSettings(event.target.value)} rows={3} placeholder='{"X-API-Key": "your-key"}' className={`${fieldClass} mt-2 h-auto py-2 font-mono text-xs`} /></details>}
        {authMethod !== "none" && <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground"><LuShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />{isOAuth ? t("dialog.security.oauth") : t("dialog.security.credentials")}</p>}
        {error && <div role="alert" className="break-words rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">{error}{saved && <span className="mt-1 block">{t("dialog.savedInactiveNotice")}</span>}</div>}
        {busy && isOAuth && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{t("dialog.status.completeInProvider")}</p>}
        <div className="flex items-center gap-2 border-t border-border pt-4">
          {saved && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={disconnect} className="mr-auto text-destructive"><LuTrash2 className="h-3.5 w-3.5" />{t("dialog.actions.disconnect")}</Button>}
          {busy && isOAuth && <Button type="button" variant="outline" size="sm" onClick={() => oauthAbort.current?.abort()}>{t("dialog.actions.cancelAuth")}</Button>}
          {token ? <Button type="submit" disabled={busy} className="ml-auto rounded-lg px-5">{busy ? <LuLoader className="h-4 w-4 animate-spin" /> : <LuPlug className="h-4 w-4" />}{busy ? isOAuth ? t("dialog.actions.waitingAuth") : t("dialog.actions.verifying") : isOAuth ? saved?.oauth_connected ? t("dialog.actions.reconnectAccount") : t("dialog.actions.connectAccount") : saved ? t("dialog.actions.saveAndVerify") : t("dialog.actions.connect")}</Button> : <Button type="button" onClick={() => useSigninStore.getState().setOpen(true)} className="ml-auto">{t("dialog.actions.signInToConnect")}</Button>}
        </div>
      </form>}
      <p className="text-[10px] text-muted-foreground">
        <Trans i18nKey="dialog.footerManage" ns="connectors" components={{ link: <Link to="/integrations" onClick={onClose} className="underline underline-offset-2" /> }} />
      </p>
    </DialogContent>
  </Dialog>;
}
