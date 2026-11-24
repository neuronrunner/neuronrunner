export type PreviewAddress = { kind: "workspace"; port: number; path: string } | { kind: "external"; url: string };

export const RESERVED_WORKSPACE_PORTS = new Set([22, 5901, 6001, 6080, 7111, 7681, 8765, 8766, 8767, 9222]);

/** Localhost always means the workspace, never the user's own computer. */
export function parsePreviewAddress(value: string): PreviewAddress {
  const address = value.trim();
  if (!address) throw new Error("Enter a localhost port or an HTTPS address.");
  if (/^\d+$/.test(address)) {
    const port = Number(address);
    if (port < 1 || port > 65535) throw new Error("Choose a port between 1 and 65535.");
    if (RESERVED_WORKSPACE_PORTS.has(port)) {
      throw new Error(`Port ${port} is reserved for workspace services.`);
    }
    return { kind: "workspace", port, path: "/" };
  }
  const url = new URL(/^https?:\/\//i.test(address) ? address : `http://${address}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP or HTTPS address without login credentials.");
  }
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)) {
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (RESERVED_WORKSPACE_PORTS.has(port)) {
      throw new Error(`Port ${port} is reserved for workspace services.`);
    }
    return { kind: "workspace", port, path: `${url.pathname}${url.search}${url.hash}` };
  }
  if (url.protocol !== "https:") throw new Error("Use HTTPS for external websites.");
  return { kind: "external", url: url.href };
}

export function previewError(error: unknown): string {
  const failure = error as { response?: { data?: { error?: string; detail?: string; port?: string[]; path?: string[] } }; message?: string };
  const data = failure.response?.data;
  return data?.error || data?.detail || data?.port?.[0] || data?.path?.[0] || failure.message || "Could not open this page.";
}
