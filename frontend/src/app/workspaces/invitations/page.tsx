"use client";

import { env } from "@/lib/env";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useSearchParams } from "@/lib/navigation";
import { LuCircleCheck, LuUsers } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { authedAxios } from "@/lib/axios";
import useAuthStore from "@/stores/auth";
import useWorkspacesStore from "@/stores/workspaces";

const API_BASE = env.API_URL || "";

export default function WorkspaceInvitationPage() {
  const { t } = useTranslation("workspace");
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { user, token: authToken } = useAuthStore();
  const [state, setState] = useState<"ready" | "accepting" | "accepted" | "error">("ready");
  const [message, setMessage] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");

  const acceptInvitation = async () => {
    if (!token) return;
    setState("accepting");
    setMessage("");
    try {
      const { data } = await authedAxios.post(
        `${API_BASE}/sandbox/workspace-invitations/${token}/accept/`
      );
      setWorkspaceName(data.name || t("invitations.defaultWorkspaceName"));
      setState("accepted");
      await useWorkspacesStore.getState().fetchWorkspaces();
    } catch (error: any) {
      setState("error");
      setMessage(
        error?.response?.data?.error || t("invitations.acceptError")
      );
    }
  };

  const signedIn = Boolean(user && authToken);

  return (
    <main className="flex min-h-[calc(100dvh-var(--app-header-height))] items-center justify-center px-4 py-10 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border/70 bg-card/60 p-6 text-center shadow-xl shadow-black/10">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-400">
          {state === "accepted" ? <LuCircleCheck className="h-6 w-6" /> : <LuUsers className="h-6 w-6" />}
        </div>

        {!token ? (
          <>
            <h1 className="mt-4 text-xl font-semibold">{t("invitations.invalidTitle")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("invitations.invalidDescription")}</p>
          </>
        ) : state === "accepted" ? (
          <>
            <h1 className="mt-4 text-xl font-semibold">{t("invitations.acceptedTitle")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("invitations.acceptedDescription", { name: workspaceName })}</p>
            <Button asChild className="mt-6">
              <Link to="/workspaces">{t("invitations.openWorkspaces")}</Link>
            </Button>
          </>
        ) : (
          <>
            <h1 className="mt-4 text-xl font-semibold">{t("invitations.joinTitle")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("invitations.joinDescription")}
            </p>
            {!signedIn && (
              <p className="mt-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                {t("invitations.signInHint")}
              </p>
            )}
            {state === "error" && <p className="mt-4 text-sm text-red-400">{message}</p>}
            <Button
              className="mt-6"
              onClick={() => void acceptInvitation()}
              disabled={!signedIn || state === "accepting"}
              loading={state === "accepting"}
            >
              {t("invitations.acceptButton")}
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
