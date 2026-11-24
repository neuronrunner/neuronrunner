import i18n from "@/i18n";
import snapshot from "@/data/connectors.json";

export const connectorCategories = ["Development", "Productivity", "Communication", "Data & analytics", "Design", "Sales & marketing", "Research", "Infrastructure", "Finance"] as const;
export type ConnectorCategory = typeof connectorCategories[number];

const categoryKeyMap = {
  "All": "all",
  "Popular": "popular",
  "New & Noteworthy": "newNoteworthy",
  "Development": "development",
  "Productivity": "productivity",
  "Communication": "communication",
  "Data & analytics": "dataAnalytics",
  "Design": "design",
  "Sales & marketing": "salesMarketing",
  "Research": "research",
  "Infrastructure": "infrastructure",
  "Finance": "finance",
  "Custom": "custom",
} as const;

type CategoryKey = (typeof categoryKeyMap)[keyof typeof categoryKeyMap];

export function connectorCategoryLabel(category: string): string {
  const key = categoryKeyMap[category as keyof typeof categoryKeyMap] as CategoryKey | undefined;
  return key ? i18n.t(`connectors:categories.${key}`) : category;
}

export function connectorCategoryDescription(category: string): string {
  const key = categoryKeyMap[category as keyof typeof categoryKeyMap] as CategoryKey | undefined;
  if (!key || key === "all" || key === "custom") return "";
  return i18n.t(`connectors:categoryDescriptions.${key}`);
}
export interface ConnectorInput {
  name?: string;
  description?: string;
  value?: string;
  default?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  type?: string;
}
export interface ConnectorRemote {
  type: "sse" | "streamable-http";
  url: string;
  headers?: ConnectorInput[];
  variables?: Record<string, ConnectorInput>;
  authentication?: "oauth" | "token" | "none";
  deprecated?: boolean;
}
export interface ConnectorPackage {
  registryType: "npm" | "pypi" | "oci";
  identifier: string;
  version: string;
  additionalPackages?: string[];
  executable?: string;
  runtimeArguments?: ConnectorInput[];
  packageArguments?: ConnectorInput[];
  environmentVariables?: ConnectorInput[];
}
export interface Connector {
  id: string;
  name: string;
  description: string;
  version: string;
  category: ConnectorCategory;
  publisher: string;
  website: string;
  logo: string;
  logoSource: string;
  featured: boolean;
  hidden?: boolean;
  curated?: boolean;
  thirdPartyGateway?: boolean;
  availability?: "provider-setup";
  chatgptDirectory?: {
    name: string;
    pluginId: string;
    url: string;
    retrievedAt: string;
  };
  remotes: ConnectorRemote[];
  packages: ConnectorPackage[];
}
export interface ConnectorServer {
  uuid: string;
  workspace: string | null;
  name: string;
  transport: "http" | "stdio";
  http_transport: "sse" | "streamable-http";
  url: string | null;
  command: string | null;
  enabled: boolean;
  has_headers: boolean;
  has_environment: boolean;
  auth_type: "manual" | "oauth";
  oauth_connected: boolean;
  tools: { name: string; description: string }[];
}

export function connectorRemotes(connector: Connector) {
  return connector.remotes.filter((remote) => !remote.deprecated && !/[{}<>]/.test(remote.url));
}

export function connectorHasUsableRemote(connector: Connector) {
  return connectorRemotes(connector).length > 0;
}

const CLOUDFLARE_ENDPOINT_LABELS: Record<string, string> = {
  docs: "Docs",
  observability: "Observability",
  bindings: "Workers Bindings",
  builds: "Workers Builds",
  radar: "Radar",
  containers: "Containers",
  browser: "Browser Rendering",
  logs: "Logpush",
  "ai-gateway": "AI Gateway",
  autorag: "AutoRAG",
  auditlogs: "Audit Logs",
  "dns-analytics": "DNS Analytics",
  dex: "DEX",
  casb: "CASB",
  graphql: "GraphQL",
};

function parseUrlHostPath(url: string): { host: string; path: string } | null {
  const match = url.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?/i);
  if (!match) return null;
  return {
    host: match[1].toLowerCase(),
    path: (match[2] || "").replace(/\/+$/, ""),
  };
}

function remoteVariantLabel(remote: ConnectorRemote, index: number, remotes: ConnectorRemote[]): string {
  const parsed = parseUrlHostPath(remote.url);
  if (parsed) {
    const { host, path } = parsed;

    if (host.endsWith(".mcp.cloudflare.com")) {
      const slug = host.slice(0, -".mcp.cloudflare.com".length);
      if (CLOUDFLARE_ENDPOINT_LABELS[slug]) {
        return CLOUDFLARE_ENDPOINT_LABELS[slug];
      }
      return slug;
    }

    if (host === "mcp.postman.com" || host === "mcp.eu.postman.com") {
      const region = host.includes(".eu.") ? "EU" : "US";
      const tier = path === "/minimal" ? "Minimal" : "Full";
      return `${region} · ${tier}`;
    }

    if (host === "mcp.api.coingecko.com") return "Public";
    if (host === "mcp.pro-api.coingecko.com") return "Pro";

    if (host === "mcp.atlassian.com") {
      if (path.startsWith("/v2")) return "v2";
      if (path.startsWith("/v1")) return "v1";
    }

    const isEuHost = (value: string) => {
      const h = parseUrlHostPath(value)?.host || "";
      return h.startsWith("mcp-eu.") || h.includes(".eu.");
    };
    if (isEuHost(remote.url)) return "EU";
    if (remotes.some((other) => other.type === remote.type && isEuHost(other.url))) return "US";
  }

  return String(index + 1);
}

export function connectorRemoteSuffix(remote: ConnectorRemote, index: number, remotes: ConnectorRemote[]): string {
  if (remotes.length <= 1) return "";
  const sameProtocolCount = remotes.filter((item) => item.type === remote.type).length;
  if (sameProtocolCount <= 1) return "";
  return ` (${remoteVariantLabel(remote, index, remotes)})`;
}

const CURATED_ORDER = [
  "app.linear/linear",
  "com.notion/mcp",
  "io.github.getsentry/sentry-mcp",
  "io.github.upstash/context7",
  "com.supabase/mcp",
  "com.neon/mcp",
  "com.vercel/vercel-mcp",
  "com.cloudflare.mcp/mcp",
  "io.github.firecrawl/firecrawl-mcp-server",
  "ai.exa/exa",
  "com.figma.mcp/mcp",
  "com.atlassian/atlassian-mcp-server",
];

const curatedRank = (connector: Connector) => {
  const index = CURATED_ORDER.indexOf(connector.id);
  return index === -1 ? CURATED_ORDER.length : index;
};

export const connectors = (snapshot.connectors as unknown as Connector[]).filter((connector) => !connector.hidden);
export const connectableConnectors = connectors
  .filter((connector) => connectorHasUsableRemote(connector) && connector.thirdPartyGateway !== true)
  .sort((a, b) => curatedRank(a) - curatedRank(b) || a.name.localeCompare(b.name));
export const recommendedConnectors = connectableConnectors.filter((connector) => connector.curated === true);
export const catalogSource = snapshot.source;
export const catalogDate = snapshot.retrievedAt;

export function connectorCanConnect(connector: Connector) {
  return connector.availability !== "provider-setup" && Boolean(connector.remotes.length || connector.packages.length);
}

// Stable identifiers keep catalog entries linked to installed servers after a reload.
export function connectorServerName(connector: Connector) {
  return connector.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

const quoteArgument = (value: string) => /^[a-zA-Z0-9@_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;

export function packageCommand(pkg: ConnectorPackage) {
  const identifier = pkg.registryType === "npm" ? `${pkg.identifier}@${pkg.version}` : pkg.registryType === "pypi" ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
  const prefix = pkg.registryType === "npm" ? "npx -y" : pkg.registryType === "pypi" ? "uvx" : "docker run --rm -i";
  const argumentsText = (inputs: ConnectorInput[] = []) => inputs.flatMap((arg) => {
    const value = arg.value ?? arg.default ?? (arg.isRequired ? `<${arg.name || "value"}>` : "");
    if (!value) return [];
    return arg.type === "named" && arg.name ? [quoteArgument(arg.name), quoteArgument(value)] : [quoteArgument(value)];
  });
  const runtime = argumentsText(pkg.runtimeArguments);
  const packageArgs = argumentsText(pkg.packageArguments);
  const env = pkg.registryType === "oci" ? (pkg.environmentVariables || []).flatMap((input) => input.name ? ["-e", quoteArgument(input.name)] : []) : [];
  if (pkg.registryType === "npm" && pkg.additionalPackages?.length && pkg.executable) {
    return [prefix, ...runtime, ...[identifier, ...pkg.additionalPackages].map((item) => `--package=${quoteArgument(item)}`), "--", quoteArgument(pkg.executable), ...packageArgs].join(" ");
  }
  return [prefix, ...runtime, ...env, quoteArgument(identifier), ...packageArgs].join(" ");
}

function isHtml(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<head") ||
    trimmed.startsWith("<body") ||
    /<[a-z][\s\S]*>/i.test(trimmed)
  );
}

function isTechnicalError(text: string): boolean {
  if (typeof text !== "string") return false;
  return (
    isHtml(text) ||
    text.includes("Traceback (most recent call last)") ||
    text.includes("ProgrammingError") ||
    text.includes("OperationalError") ||
    text.includes("DatabaseError") ||
    text.includes("django.db") ||
    text.includes("psycopg2")
  );
}

export function connectorError(error: unknown): string {
  if (!error) {
    return i18n.t("connectors:errors.unexpected");
  }

  const err = error as {
    name?: string;
    message?: string;
    code?: string;
    response?: {
      status?: number;
      data?: unknown;
    };
  };

  if (err.name === "CanceledError" || err.name === "AbortError") {
    return "";
  }

  const response = err.response;
  if (!response) {
    if (
      typeof err.message === "string" &&
      err.message !== "Network Error" &&
      err.code !== "ERR_NETWORK" &&
      err.code !== "ECONNREFUSED" &&
      !isTechnicalError(err.message)
    ) {
      return err.message.trim();
    }
    return i18n.t("connectors:errors.unreachable");
  }

  const status = response.status;
  const data = response.data;

  // Preserve intentional MCP startup diagnostics while keeping generic gateway
  // pages and backend tracebacks behind the existing friendly error handling.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const fields = data as Record<string, unknown>;
    if ((fields.error_code === "mcp_timeout" || fields.error_code === "mcp_connection_failed") && typeof fields.error === "string" && fields.error.startsWith("MCP ") && !isTechnicalError(fields.error)) {
      return fields.error.trim().slice(0, 4500);
    }
  }

  if (status && status >= 500) {
    if (status === 502 || status === 503 || status === 504) {
      return i18n.t("connectors:errors.serverUnavailable");
    }

    if (data && typeof data === "object" && !Array.isArray(data)) {
      const explicitError = (data as Record<string, unknown>).error || (data as Record<string, unknown>).detail;
      if (typeof explicitError === "string" && !isTechnicalError(explicitError) && explicitError.trim().length <= 300) {
        return explicitError.trim();
      }
    }

    return i18n.t("connectors:errors.serverError");
  }

  if (status === 401 || status === 403) {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const detail = (data as Record<string, unknown>).detail || (data as Record<string, unknown>).error;
      if (typeof detail === "string" && !isTechnicalError(detail)) {
        return detail.trim();
      }
    }
    return status === 401
      ? i18n.t("connectors:errors.sessionExpired")
      : i18n.t("connectors:errors.forbidden");
  }

  if (status === 404) {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const detail = (data as Record<string, unknown>).detail || (data as Record<string, unknown>).error;
      if (typeof detail === "string" && !isTechnicalError(detail)) {
        return detail.trim();
      }
    }
    return i18n.t("connectors:errors.notFound");
  }

  if (typeof data === "string") {
    if (!isTechnicalError(data) && data.trim().length <= 300) {
      return data.trim();
    }
    return i18n.t("connectors:errors.invalidRequest");
  }

  if (data && typeof data === "object") {
    if (Array.isArray(data)) {
      const safe = data.filter((item): item is string => typeof item === "string" && !isTechnicalError(item));
      if (safe.length) return safe.join(" ");
    } else {
      const dict = data as Record<string, unknown>;
      const direct = dict.error || dict.detail || dict.message;
      if (typeof direct === "string" && !isTechnicalError(direct)) {
        return direct.trim();
      }

      const extracted: string[] = [];
      for (const [, value] of Object.entries(dict)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string" && !isTechnicalError(item)) {
              extracted.push(item);
            }
          }
        } else if (typeof value === "string" && !isTechnicalError(value)) {
          extracted.push(value);
        }
      }
      if (extracted.length) {
        return extracted.join(" ");
      }
    }
  }

  if (typeof err.message === "string" && !("response" in err) && !isTechnicalError(err.message)) {
    return err.message.trim();
  }

  return i18n.t("connectors:errors.unreachable");
}
