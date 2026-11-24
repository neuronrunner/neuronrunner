"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuClock3, LuEllipsis, LuLoaderCircle, LuMail, LuSearch, LuTrash2, LuUserPlus, LuUsers, LuX } from "react-icons/lu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toaster } from "@/components/ui/toaster";
import useAuthStore from "@/stores/auth";
import useWorkspacesStore, { type IWorkspaceMember, type IWorkspaceInvitation } from "@/stores/workspaces";
import { WorkspaceAvatar, WorkspaceRoleBadge } from "./workspace-identity";

const tabClass = "gap-2 rounded-none border-b-2 border-transparent px-0 py-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none";

export default function ManageWorkspaceMembersDialog() {
  const { t } = useTranslation("workspace");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [isAdding, setIsAdding] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [section, setSection] = useState("members");
  const [query, setQuery] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<IWorkspaceMember | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [cancelingInvitationId, setCancelingInvitationId] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const userUuid = useAuthStore((state) => state.user?.uuid);
  const { currentWorkspace, isMembersDialogOpen, setMembersDialogOpen, inviteMember, removeMember, cancelInvitation, errorMessage, resetError } = useWorkspacesStore();
  const canManage = currentWorkspace?.user_role === "owner" || currentWorkspace?.user_role === "admin";
  const members = currentWorkspace?.members || [];
  const invitations = currentWorkspace?.pending_invitations || [];
  const search = query.trim().toLocaleLowerCase();
  const loadingSubscription = false;
  const planSlug: string = "self_hosted";
  const planName = "Self-Hosted";
  const isIndividualPlan = false;

  const filteredMembers = members.filter((member) => `${member.display_name} ${member.email}`.toLocaleLowerCase().includes(search));
  const filteredInvitations = invitations.filter((invitation) => invitation.email.toLocaleLowerCase().includes(search));

  useEffect(() => {
    if (!isMembersDialogOpen) return;
    setEmail("");
    setRole("member");
    setInviteOpen(false);
    setQuery("");
    setSection("members");
    setPendingRemoval(null);
    resetError();
  }, [isMembersDialogOpen, currentWorkspace?.uuid, resetError]);

  useEffect(() => {
    if (inviteOpen && !isAdding) emailRef.current?.focus();
  }, [inviteOpen, isAdding]);

  const handleInvite = async () => {
    if (!email.trim() || !canManage || isAdding) return;
    setIsAdding(true);
    try {
      const invitation = await inviteMember(email.trim(), role);
      if (!invitation) return;
      setEmail("");
      setQuery("");
      setSection("invitations");
      toaster.create({ title: t("membersDialog.invitationSent"), description: t("membersDialog.invitationSentDescription", { email: invitation.email }), type: "success" });
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemove = async () => {
    if (!pendingRemoval || isRemoving) return;
    setIsRemoving(true);
    try {
      const removed = await removeMember(pendingRemoval.user_uuid);
      if (!removed) return;
      toaster.create({ title: t("membersDialog.memberRemoved"), description: pendingRemoval.display_name || pendingRemoval.email, type: "info" });
      setPendingRemoval(null);
    } finally {
      setIsRemoving(false);
    }
  };

  const handleCancelInvitation = async (invitation: IWorkspaceInvitation) => {
    if (!canManage || cancelingInvitationId) return;
    setCancelingInvitationId(invitation.uuid);
    try {
      const ok = await cancelInvitation(invitation.uuid);
      if (ok) {
        toaster.create({
          title: t("membersDialog.invitationCancelled"),
          description: t("membersDialog.invitationCancelledDescription", { email: invitation.email }),
          type: "info",
        });
      }
    } finally {
      setCancelingInvitationId(null);
    }
  };

  return (
    <Dialog open={isMembersDialogOpen} onOpenChange={(open) => { if (!isAdding && !isRemoving) setMembersDialogOpen(open); }}>
      <DialogContent className="flex max-h-[calc(100dvh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-[640px] flex-col gap-0 overflow-hidden rounded-2xl p-0" hideClose={isAdding || isRemoving}>
        <DialogHeader className="shrink-0 px-5 pb-5 pt-6 text-left sm:px-6">
          <div className="flex items-center gap-3 pr-6">
            <WorkspaceAvatar
              name={currentWorkspace?.name || t("membersDialog.defaultWorkspaceName")}
              image={currentWorkspace?.profile_picture}
              blurDataUrl={currentWorkspace?.profile_picture_blur_data_url}
              className="h-11 w-11 text-sm"
            />
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg">{t("membersDialog.title")}</DialogTitle>
              <DialogDescription className="mt-1 truncate text-xs">{currentWorkspace?.name || t("membersDialog.defaultWorkspaceName")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Tabs value={section} onValueChange={(value) => { setSection(value); setQuery(""); }} className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 sm:px-6">
            <TabsList aria-label={t("membersDialog.teamListsAria")} className="h-auto justify-start gap-4 rounded-none bg-transparent p-0 sm:gap-6">
              <TabsTrigger value="members" className={tabClass}>{t("membersDialog.membersTab")} <span className="text-[10px] tabular-nums text-muted-foreground">{members.length}</span></TabsTrigger>
              {canManage && <TabsTrigger value="invitations" className={tabClass}>{t("membersDialog.invitationsTab")} <span className="text-[10px] tabular-nums text-muted-foreground">{invitations.length}</span></TabsTrigger>}
            </TabsList>
            {canManage && !isIndividualPlan && <Button variant={inviteOpen ? "secondary" : "default"} size="sm" onClick={() => { setInviteOpen(!inviteOpen); resetError(); }} aria-expanded={inviteOpen} aria-controls="team-invite-form" disabled={isAdding} className="h-7 rounded-md px-2 text-[11px] sm:px-3"><LuUserPlus /><span className="hidden sm:inline">{t("membersDialog.inviteMember")}</span><span className="sm:hidden">{t("membersDialog.invite")}</span></Button>}
          </div>

          <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
            {isIndividualPlan && !loadingSubscription && (
              <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-600 dark:text-amber-400">
                <p className="font-semibold">{t("membersDialog.planUnavailableTitle", { plan: planName })}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {planSlug === "free"
                    ? t("membersDialog.planUnavailableFree")
                    : t("membersDialog.planUnavailablePlus")}
                </p>
              </div>
            )}

            {canManage && !isIndividualPlan && inviteOpen && (
              <form id="team-invite-form" onSubmit={(event) => { event.preventDefault(); void handleInvite(); }} className="mb-4 space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3.5">
                <div className="flex items-center justify-between"><p className="text-xs font-medium">{t("membersDialog.inviteTeammate")}</p><button type="button" aria-label={t("membersDialog.closeInviteForm")} disabled={isAdding} onClick={() => setInviteOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><LuX className="h-3.5 w-3.5" /></button></div>
                <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-2 sm:grid-cols-[minmax(0,1fr)_110px_auto]">
                  <div className="col-span-2 min-w-0 space-y-1.5 sm:col-span-1"><label htmlFor="team-invite-email" className="text-[11px] text-muted-foreground">{t("membersDialog.emailLabel")}</label><Input ref={emailRef} id="team-invite-email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); if (errorMessage) resetError(); }} placeholder={t("membersDialog.emailPlaceholder")} required disabled={isAdding} className="h-9 rounded-lg bg-background text-xs" /></div>
                  <div className="space-y-1.5"><label htmlFor="team-invite-role" className="text-[11px] text-muted-foreground">{t("membersDialog.roleLabel")}</label><Select value={role} onValueChange={(value) => setRole(value as "member" | "admin")} disabled={isAdding}><SelectTrigger id="team-invite-role" aria-label={t("membersDialog.roleAria")} className="h-9 rounded-lg bg-background text-xs"><SelectValue /></SelectTrigger><SelectContent className="z-[1300]"><SelectItem value="member">{t("roles.member")}</SelectItem><SelectItem value="admin">{t("roles.admin")}</SelectItem></SelectContent></Select></div>
                  <Button type="submit" loading={isAdding} disabled={!email.trim() || isAdding} className="h-9 self-end rounded-lg text-xs">{isAdding ? t("membersDialog.sending") : t("membersDialog.sendInvite")}</Button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{role === "admin" ? t("membersDialog.adminRoleHint") : t("membersDialog.memberRoleHint")}</p>
              </form>
            )}

            {pendingRemoval && (
              <div role="alert" className="mb-4 space-y-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3.5">
                <div><p className="break-words text-xs font-medium">{t("membersDialog.removeConfirmTitle", { name: pendingRemoval.display_name || pendingRemoval.email })}</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t("membersDialog.removeConfirmDescription")}</p></div>
                <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={isRemoving} onClick={() => { setPendingRemoval(null); resetError(); }}>{t("common.cancel")}</Button><Button variant="destructive" size="sm" loading={isRemoving} disabled={isRemoving} onClick={() => void handleRemove()}>{isRemoving ? t("membersDialog.removing") : t("membersDialog.removeMember")}</Button></div>
              </div>
            )}
            {errorMessage && <p role="alert" className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">{errorMessage}</p>}

            <div className="relative mb-3"><LuSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={section === "members" ? t("membersDialog.searchMembersAria") : t("membersDialog.searchInvitationsAria")} placeholder={section === "members" ? t("membersDialog.searchMembersPlaceholder") : t("membersDialog.searchInvitationsPlaceholder")} className="h-9 rounded-lg pl-9 pr-9 text-xs shadow-none" />{query && <button type="button" aria-label={t("projectDetail.chats.clearSearchAria")} onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"><LuX className="h-3.5 w-3.5" /></button>}</div>

            <TabsContent value="members" className="mt-0 min-h-[180px]">
              <ul className="divide-y divide-border/50">
                {filteredMembers.map((member) => {
                  const name = member.display_name || member.email;
                  const canRemove = canManage && member.role !== "owner" && (currentWorkspace?.user_role === "owner" || member.role !== "admin");
                  return <li key={member.uuid} className="flex min-w-0 items-center gap-2.5 py-3 sm:gap-3">
                    <WorkspaceAvatar name={name} className="h-8 w-8 rounded-full bg-muted text-[11px] text-muted-foreground dark:text-muted-foreground" />
                    <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium" title={name}>{name}{member.user_uuid === userUuid && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{t("membersDialog.you")}</span>}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={member.email}>{member.email}</p></div>
                    <WorkspaceRoleBadge role={member.role} />
                    {canRemove && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={t("membersDialog.actionsFor", { name })}
                            disabled={isRemoving}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <LuEllipsis className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="z-[1300]">
                          <DropdownMenuItem
                            onSelect={() => {
                              setPendingRemoval(member);
                              resetError();
                            }}
                            className="text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
                          >
                            <LuTrash2 />
                            {t("membersDialog.removeFromWorkspace")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>;
                })}
              </ul>
              {!filteredMembers.length && <EmptyList icon="members" title={query ? t("membersDialog.emptySearchMembersTitle") : t("membersDialog.emptyMembersTitle")} description={query ? t("membersDialog.emptySearchMembersDesc") : t("membersDialog.emptyMembersDesc")} />}
            </TabsContent>
            {canManage && (
              <TabsContent value="invitations" className="mt-0 min-h-[180px]">
                <ul className="divide-y divide-border/50">
                  {filteredInvitations.map((invitation) => (
                    <li key={invitation.uuid} className="flex min-w-0 items-center gap-3 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <LuMail className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" title={invitation.email}>
                          {invitation.email}
                        </p>
                        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <LuClock3 className="h-3 w-3 shrink-0" />
                          {t("membersDialog.awaitingAcceptance")}
                        </p>
                      </div>
                      <WorkspaceRoleBadge role={invitation.role} />
                      {canManage && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={cancelingInvitationId === invitation.uuid}
                          onClick={() => void handleCancelInvitation(invitation)}
                          aria-label={t("membersDialog.cancelInvitationAria", { email: invitation.email })}
                          className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/30 hover:bg-destructive/5 gap-1.5 rounded-lg shrink-0 transition-colors"
                        >
                          {cancelingInvitationId === invitation.uuid ? (
                            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <LuTrash2 className="h-3.5 w-3.5" />
                          )}
                          <span>{t("common.cancel")}</span>
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {!filteredInvitations.length && (
                  <EmptyList
                    icon="invitations"
                    title={query ? t("membersDialog.emptySearchInvitationsTitle") : t("membersDialog.emptyInvitationsTitle")}
                    description={
                      query
                        ? t("membersDialog.emptySearchInvitationsDesc")
                        : t("membersDialog.emptyInvitationsDesc")
                    }
                  />
                )}
              </TabsContent>
            )}
          </div>
        </Tabs>

        <DialogFooter className="shrink-0 flex-row items-center justify-between gap-3 border-t border-border/60 bg-muted/10 px-5 py-3 sm:justify-between sm:space-x-0 sm:px-6">
          <p className="text-[11px] text-muted-foreground">{canManage ? t("membersDialog.footerCanManage") : t("membersDialog.footerReadOnly")}</p>
          <Button variant="outline" size="sm" disabled={isAdding || isRemoving} onClick={() => setMembersDialogOpen(false)} className="rounded-lg">{t("common.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyList({ icon, title, description }: { icon: "members" | "invitations"; title: string; description: string }) {
  const Icon = icon === "members" ? LuUsers : LuMail;
  return <div className="flex flex-col items-center px-3 py-10 text-center"><span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"><Icon className="h-4 w-4" /></span><p className="text-xs font-medium">{title}</p><p className="mt-1 max-w-[280px] text-[11px] leading-relaxed text-muted-foreground">{description}</p></div>;
}
