import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams as useRouterSearchParams } from "react-router-dom";
import frontendExtension from "@cloud";

export { useParams } from "react-router-dom";

/** Shared navigation helpers keep imperative actions consistent across the app. */
export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({
    push: (path: string) => navigate(path),
    replace: (path: string) => navigate(path, { replace: true }),
    back: () => navigate(-1),
  }), [navigate]);
}

export function usePathname() {
  return useLocation().pathname.replace(/\/+$/, "") || "/";
}

export function useSearchParams() {
  return useRouterSearchParams()[0];
}

export function isKnownRoute(pathname: string): boolean {
  if (!pathname) return false;
  const p = pathname.replace(/\/+$/, "") || "/";

  if (
    p === "/" ||
    p === "/new" ||
    p === "/chat" ||
    p.startsWith("/chat/") ||
    p === "/projects" ||
    p.startsWith("/projects/") ||
    p === "/workspaces" ||
    p.startsWith("/workspaces/") ||
    p === "/inference" ||
    p.startsWith("/inference/") ||
    p === "/docs" ||
    p.startsWith("/docs/") ||
    p === "/hello" ||
    p === "/issues" ||
    p.startsWith("/issues/") ||
    p === "/pull-requests" ||
    p.startsWith("/pull-requests/") ||
    p === "/integrations" ||
    p.startsWith("/integrations/") ||
    p === "/connectors" ||
    p.startsWith("/connectors/") ||
    p === "/terms-of-service" ||
    p === "/privacy-policy"
  ) {
    return true;
  }

  return frontendExtension.routes.some(
    (route) => (route.path.replace(/\/+$/, "") || "/") === p,
  );
}

