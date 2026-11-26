import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { Provider } from "@/app/provider";
import { LoadingDots } from "@/components/loading-dots";
import { env } from "@/lib/env";
import { captureAttributionFromWindow } from "@/lib/attribution";
import useAuthStore from "@/stores/auth";
import useChatStore from "@/stores/chat";
import useLlmSetupStore, { needsLlmSetup } from "@/stores/llm-setup";
import useWorkspacesStore from "@/stores/workspaces";
import frontendExtension from "@cloud";

const Home = lazy(() => import("@/app/page"));
const ChatWorkspace = lazy(() => import("@/components/chat/chat-workspace"));
const Project = lazy(() => import("@/app/projects/[slug]/page"));
const WorkspaceInvitations = lazy(() => import("@/app/workspaces/invitations/page"));
const Hello = lazy(() => import("@/app/hello/page"));
const Docs = lazy(() => import("@/app/docs/page"));
const Issues = lazy(() => import("@/app/issues/page"));
const PullRequests = lazy(() => import("@/app/pull-requests/page"));
const MCPOAuthCallback = lazy(() => import("@/app/integrations/oauth/callback"));
const Integrations = lazy(() => import("@/app/integrations/page"));
import Terms from "@/app/terms-of-service/page";
import Privacy from "@/app/privacy-policy/page";
const NotFound = lazy(() => import("@/app/not-found"));

function LegacyWorkspaceRedirect() {
  const location = useLocation();
  return <Navigate replace to={`${location.pathname.replace(/^\/workspaces/, "/projects")}${location.search}${location.hash}`} />;
}

function LegacyConnectorsRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate replace to={`${to}${location.search}${location.hash}`} />;
}

function NavigationEffects() {
  const { pathname } = useLocation();
  useEffect(() => { captureAttributionFromWindow(); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function HomeRoute() {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const location = useLocation();
  if (user && token) {
    return <Navigate replace to={`/new${location.search}${location.hash}`} />;
  }
  return <Home />;
}

/**
 * Every workspace chats on its own key or subscription. Returns true once we know
 * the current workspace has no usable model, and keeps the selected model on one
 * the workspace can actually run.
 */
function useNeedsLlmSetup(enabled: boolean): boolean {
  const workspaceUuid = useWorkspacesStore((s) => s.currentWorkspaceUuid);
  const hasLoadedWorkspaces = useWorkspacesStore((s) => s.hasLoaded);
  const status = useLlmSetupStore((s) => s.status);
  const statusWorkspace = useLlmSetupStore((s) => s.workspaceUuid);
  const fetchStatus = useLlmSetupStore((s) => s.fetchStatus);

  useEffect(() => {
    if (enabled && !hasLoadedWorkspaces) void useWorkspacesStore.getState().fetchWorkspaces();
  }, [enabled, hasLoadedWorkspaces]);

  useEffect(() => {
    if (enabled && workspaceUuid) void fetchStatus(workspaceUuid);
  }, [enabled, workspaceUuid, fetchStatus]);

  const current = enabled && statusWorkspace === workspaceUuid ? status : null;

  useEffect(() => {
    if (!current || current.usable_models.length === 0) return;
    // usable_models is capped; only correct the selection when it is the full list.
    if (current.usable_model_count > current.usable_models.length) return;
    const chat = useChatStore.getState();
    if (!current.usable_models.some((m) => m.name === chat.selectedModel)) {
      chat.setSelectedModel(current.usable_models[0].name);
    }
  }, [current]);

  return needsLlmSetup(current);
}

function ChatWorkspaceRoute() {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const location = useLocation();
  const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
  const signedIn = Boolean(user && token);
  const needsSetup = useNeedsLlmSetup(signedIn);
  if (normalizedPath === "/new" && !signedIn) {
    return <Navigate replace to={`/${location.search}${location.hash}`} />;
  }
  if (needsSetup) {
    return <Navigate replace to="/hello" />;
  }
  return <ChatWorkspace />;
}

function LegacyProjectRedirect() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <Navigate to={slug ? `/environments/${encodeURIComponent(slug)}` : "/new"} replace />;
}

export default function App() {
  const { t } = useTranslation("workspace");
  const ExtensionNavigationEffects = frontendExtension.NavigationEffects;
  return <>
    <NavigationEffects />
    <ExtensionNavigationEffects />
    <Provider>
      <Suspense fallback={<div role="status" aria-label={t("browserView.loadingPage")} className="flex min-h-64 items-center justify-center"><LoadingDots /></div>}>
        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route element={<ChatWorkspaceRoute />}>
            <Route path="/new" element={null} />
            <Route path="/chat/:uuid" element={null} />
          </Route>
          <Route path="/chat" element={<Navigate to="/new" replace />} />
          <Route path="/environments" element={<Navigate to="/new" replace />} />
          <Route path="/environments/:slug" element={<Project />} />
          <Route path="/projects" element={<Navigate to="/new" replace />} />
          <Route path="/projects/:slug" element={<LegacyProjectRedirect />} />
          <Route path="/workspaces/invitations" element={<WorkspaceInvitations />} />
          <Route path="/hello" element={<Hello />} />
          <Route path="/workspaces/*" element={<LegacyWorkspaceRedirect />} />
          <Route path="/inference" element={<Navigate to="/" replace />} />
          {env.ENABLE_DOCS ? (
            <>
              <Route path="/docs" element={<Docs />} />
              <Route path="/docs/:slug" element={<Docs />} />
            </>
          ) : (
            <Route path="/docs/*" element={<Navigate to="/" replace />} />
          )}
          <Route path="/issues" element={<Issues />} />
          <Route path="/pull-requests" element={<PullRequests />} />
          <Route path="/integrations/oauth/callback" element={<MCPOAuthCallback />} />
          <Route path="/connectors/oauth/callback" element={<LegacyConnectorsRedirect to="/integrations/oauth/callback" />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/connectors" element={<LegacyConnectorsRedirect to="/integrations" />} />
          <Route path="/terms-of-service" element={<Terms />} />
          <Route path="/privacy-policy" element={<Privacy />} />
          {frontendExtension.routes.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Provider>
  </>;
}
