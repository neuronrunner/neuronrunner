export function parseGithubRepository(value: string) {
  const input = value.trim().replace(/^git@github\.com:/i, "https://github.com/");
  let path = input;
  if (input.includes("://")) {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
      path = url.pathname.replace(/^\//, "");
    } catch { return null; }
  }
  const match = path.replace(/\/$/, "").match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return null;
  const [, owner, rawName] = match;
  const name = rawName.replace(/\.git$/i, "");
  if (!name || name === "." || name === "..") return null;
  return { owner, name, fullName: `${owner}/${name}`, url: `https://github.com/${owner}/${name}.git` };
}

export const DEFAULT_GITLAB_HOST = "gitlab.com";

/** Parse a GitLab project URL (supports nested groups and self-hosted hosts). */
export function parseGitlabRepository(value: string, host: string = DEFAULT_GITLAB_HOST) {
  const allowedHost = (host || DEFAULT_GITLAB_HOST).toLowerCase();
  let input = value.trim();
  const ssh = input.match(/^git@([^:/]+):(.+)$/i);
  if (ssh) input = `https://${ssh[1]}/${ssh[2]}`;
  let path = input;
  if (input.includes("://")) {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.host.toLowerCase() !== allowedHost || url.username || url.password || url.search || url.hash) return null;
      path = url.pathname.replace(/^\//, "");
    } catch { return null; }
  }
  path = path.replace(/\/-\/.*$/, "").replace(/\/+$/, "");
  const segments = path.split("/");
  if (segments.length < 2 || segments.some(segment => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment))) return null;
  const rawName = segments[segments.length - 1];
  const name = rawName.replace(/\.git$/i, "");
  if (!name || name === "." || name === "..") return null;
  const owner = segments.slice(0, -1).join("/");
  const fullName = `${owner}/${name}`;
  return { owner, name, fullName, url: `https://${allowedHost}/${fullName}.git` };
}

export function normalizeProjectPath(value: string): string | null {
  const path = value.trim();
  if (!path.startsWith("/workspace/") || /[\\\x00-\x1f]/.test(path)) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts.some(part => part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  return `/${parts.join("/")}`;
}
