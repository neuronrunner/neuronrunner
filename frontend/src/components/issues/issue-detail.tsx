"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowLeft,
  LuBot,
  LuExternalLink,
  LuGitBranch,
  LuGitPullRequest,
  LuLoaderCircle,
  LuMessageSquare,
  LuPencil,
  LuRefreshCw,
  LuSend,
  LuSparkles,
  LuTrash2,
  LuUser,
} from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toaster } from "@/components/ui/toaster";
import { RepositoryLoading, RepositoryTimestamp } from "@/components/git/repository-ui";
import {
  EnvironmentChip,
  IssueLabelChip,
  IssueMarkdown,
  IssuePriorityMark,
  IssueStatusChip,
  parseLabelInput,
} from "@/components/issues/issue-ui";
import {
  addIssueComment,
  deleteIssue,
  getIssue,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  issuesError,
  listIssueComments,
  unassignIssueAgent,
  updateIssue,
  type Issue,
  type IssueComment,
  type IssuePriority,
  type IssueStatus,
  type UpdateIssueInput,
} from "@/lib/issues-api";
import { useRouter } from "@/lib/navigation";
import { launchIssueAgent } from "@/stores/issue-agent";
import useChatStore from "@/stores/chat";
import type { IProject } from "@/stores/sandbox-projects";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { cn } from "@/lib/utils";

const POLL_MS = 5000;

interface IssueDetailProps {
  environment: IProject;
  number: number;
  initialIssue?: Issue | null;
  onBack: () => void;
  /** Called after any change so the list can refresh. */
  onChanged: () => void;
  onDeleted: () => void;
}

export function IssueDetail({ environment, number, initialIssue, onBack, onChanged, onDeleted }: IssueDetailProps) {
  const { t } = useTranslation("git");
  const router = useRouter();
  const environmentId = environment.uuid;

  const [issue, setIssue] = useState<Issue | null>(initialIssue ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [launching, setLaunching] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadIssue = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await getIssue(environmentId, number, signal);
        if (!signal?.aborted && mounted.current) {
          setIssue(next);
          setLoadError(null);
        }
      } catch (err) {
        if (signal?.aborted || !mounted.current) return;
        setLoadError(issuesError(err, t("issues.loadErrorTitle")));
      }
    },
    [environmentId, number, t]
  );

  const loadComments = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      if (!silent) setCommentsLoading(true);
      try {
        const next = await listIssueComments(environmentId, number, signal);
        if (!signal?.aborted && mounted.current) setComments(next);
      } catch {
        // Comments are secondary; the issue itself reports load failures.
      } finally {
        if (!signal?.aborted && mounted.current) setCommentsLoading(false);
      }
    },
    [environmentId, number]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadIssue(controller.signal);
    void loadComments(controller.signal);
    return () => controller.abort();
  }, [loadIssue, loadComments]);

  // While an agent works on the issue it updates status/comments through its tools; keep the view fresh.
  const agentActive = Boolean(issue?.assigned_to_agent && issue.status === "in_progress");
  useEffect(() => {
    if (!agentActive) return;
    const timer = window.setInterval(() => {
      void loadIssue();
      void loadComments(undefined, true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [agentActive, loadIssue, loadComments]);

  const applyUpdate = async (input: UpdateIssueInput) => {
    if (!issue) return false;
    try {
      const next = await updateIssue(environmentId, issue.number, input);
      setIssue(next);
      onChanged();
      return true;
    } catch (err) {
      toaster.create({ title: issuesError(err, t("issues.updateFailed")), type: "error" });
      return false;
    }
  };

  const startEditing = () => {
    if (!issue) return;
    setDraftTitle(issue.title);
    setDraftBody(issue.body);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!draftTitle.trim() || saving) return;
    setSaving(true);
    const ok = await applyUpdate({ title: draftTitle.trim(), body: draftBody });
    if (mounted.current) {
      setSaving(false);
      if (ok) setEditing(false);
    }
  };

  const addLabels = async () => {
    if (!issue || !labelDraft.trim()) return;
    const merged = [...issue.labels, ...parseLabelInput(labelDraft)];
    setLabelDraft("");
    await applyUpdate({ labels: merged });
  };

  const submitComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!issue || posting || !commentBody.trim()) return;
    setPosting(true);
    try {
      const created = await addIssueComment(environmentId, issue.number, commentBody.trim());
      setComments((prev) => [...prev, created]);
      setIssue((prev) => (prev ? { ...prev, comments: prev.comments + 1 } : prev));
      setCommentBody("");
      onChanged();
    } catch (err) {
      toaster.create({ title: issuesError(err, t("issues.commentFailed")), type: "error" });
    } finally {
      if (mounted.current) setPosting(false);
    }
  };

  const openAgentChat = (conversationId: string) => {
    const store = useChatStore.getState();
    store.setChatMode("chat");
    useWorkspaceTabsStore.getState().openChatTab(conversationId, issue?.title, "left");
    void store.switchConversation(conversationId);
    router.push(`/chat/${conversationId}`);
  };

  const assignToAgent = async () => {
    if (!issue || launching) return;
    setLaunching(true);
    try {
      const result = await launchIssueAgent({ issue, comments, environment });
      if (!mounted.current) return;
      setIssue(result.issue);
      onChanged();
      void loadComments(undefined, true);
      toaster.create({ title: t("issues.agentStarted", { number: issue.number }), type: "success" });
    } catch (err) {
      toaster.create({
        title: t("issues.agentStartFailed"),
        description: issuesError(err, err instanceof Error ? err.message : undefined),
        type: "error",
      });
    } finally {
      if (mounted.current) setLaunching(false);
    }
  };

  const unassignAgent = async () => {
    if (!issue) return;
    try {
      const next = await unassignIssueAgent(environmentId, issue.number);
      setIssue(next);
      onChanged();
      void loadComments(undefined, true);
    } catch (err) {
      toaster.create({ title: issuesError(err, t("issues.updateFailed")), type: "error" });
    }
  };

  const removeIssue = async () => {
    if (!issue) return;
    try {
      await deleteIssue(environmentId, issue.number);
      toaster.create({ title: t("issues.deleted", { number: issue.number }), type: "success" });
      onDeleted();
    } catch (err) {
      setConfirmDelete(false);
      toaster.create({ title: issuesError(err, t("issues.deleteFailed")), type: "error" });
    }
  };

  const backButton = (
    <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 gap-1.5 text-xs text-muted-foreground">
      <LuArrowLeft className="h-3.5 w-3.5" />
      {t("issues.backToList")}
    </Button>
  );

  if (!issue) {
    return (
      <div className="space-y-4">
        {backButton}
        {loadError ? (
          <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive">
            {loadError}
          </div>
        ) : (
          <RepositoryLoading label={t("issues.loading")} />
        )}
      </div>
    );
  }

  const externalLabel = issue.external ? (issue.external.source === "github" ? "GitHub" : "GitLab") : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {backButton}
        <div className="flex items-center gap-2">
          {!editing && (
            <Button variant="outline" size="sm" onClick={startEditing} className="gap-1.5 text-xs">
              <LuPencil className="h-3.5 w-3.5" />
              {t("issues.edit")}
            </Button>
          )}
          {confirmDelete ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => void removeIssue()} className="text-xs">
                {t("issues.confirmDelete")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} className="text-xs">
                {t("issues.cancel")}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              aria-label={t("issues.deleteIssue")}
              className="gap-1.5 text-xs text-muted-foreground hover:text-destructive"
            >
              <LuTrash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="space-y-4 border-b border-border bg-muted/20 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <IssueStatusChip status={issue.status} />
            <span className="text-xs text-muted-foreground/60">·</span>
            <span className="font-mono text-xs text-muted-foreground">{t("issues.issueNumber", { number: issue.number })}</span>
            {issue.priority !== "none" && <IssuePriorityMark priority={issue.priority} withLabel />}
            <EnvironmentChip
              name={environment.repo_full_name ? undefined : environment.display_name || environment.slug}
              repository={environment.repo_full_name}
              repoUrl={environment.repo_url}
              className="sm:ml-auto"
            />
          </div>

          {editing ? (
            <Input
              value={draftTitle}
              maxLength={300}
              autoFocus
              aria-label={t("issues.titleLabel")}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="h-10 text-base font-semibold"
            />
          ) : (
            <h2 className="break-words text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{issue.title}</h2>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 break-all font-medium text-foreground">
              {issue.creator.type === "agent" ? <LuBot className="h-3.5 w-3.5" /> : <LuUser className="h-3.5 w-3.5" />}
              {issue.creator.name || t("common.unknownAuthor")}
            </span>
            <span className="text-muted-foreground/40" aria-hidden>
              {t("common.openedThis")}
            </span>
            <RepositoryTimestamp value={issue.created_at} prefix={t("timestamps.createdPrefix")} />
            <span className="text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <RepositoryTimestamp value={issue.updated_at} prefix={t("timestamps.updatedPrefix")} />
            {issue.closed_at && issue.state === "closed" && (
              <>
                <span className="text-muted-foreground/40" aria-hidden>
                  ·
                </span>
                <RepositoryTimestamp value={issue.closed_at} prefix={t("timestamps.closedPrefix")} />
              </>
            )}
            {issue.external && externalLabel && (
              <a
                href={issue.external.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                {t("issues.importedFrom", { source: externalLabel, id: issue.external.id })}
                <LuExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 p-5 sm:p-6 lg:grid-cols-4">
          <div className="space-y-6 lg:col-span-3">
            <div>
              <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("common.description")}
              </h3>
              {editing ? (
                <div className="space-y-2">
                  <Textarea
                    rows={10}
                    value={draftBody}
                    aria-label={t("issues.descriptionLabel")}
                    onChange={(event) => setDraftBody(event.target.value)}
                    className="resize-y"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(false)} className="text-xs">
                      {t("issues.cancel")}
                    </Button>
                    <Button size="sm" loading={saving} disabled={!draftTitle.trim()} onClick={() => void saveEdit()} className="text-xs">
                      {t("issues.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border/70 bg-card p-4 sm:p-5">
                  <IssueMarkdown>{issue.body || t("common.noDescription")}</IssueMarkdown>
                </div>
              )}
            </div>

            <div className="space-y-4 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <LuMessageSquare className="h-3.5 w-3.5" />
                  <span>{t("issues.commentsTitle")}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-foreground">
                    {commentsLoading ? "…" : comments.length}
                  </span>
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={commentsLoading}
                  onClick={() => void loadComments()}
                  className="h-7 text-xs text-muted-foreground hover:text-foreground"
                >
                  <LuRefreshCw className={cn("mr-1 h-3 w-3", commentsLoading && "animate-spin")} />
                  {t("common.refresh")}
                </Button>
              </div>

              {commentsLoading && comments.length === 0 ? (
                <RepositoryLoading label={t("common.loadingComments")} />
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 py-8 text-center text-xs text-muted-foreground">
                  <LuMessageSquare className="mb-2 h-5 w-5 text-muted-foreground/40" />
                  <p>{t("issues.noComments")}</p>
                </div>
              ) : (
                <div className="space-y-3.5">
                  {comments.map((comment) => (
                    <div
                      key={comment.id}
                      className={cn(
                        "overflow-hidden rounded-xl border bg-card",
                        comment.author_type === "system" ? "border-dashed border-border/70 bg-muted/10" : "border-border"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-4 py-2.5 text-xs">
                        <div className="flex min-w-0 items-center gap-2">
                          {comment.author_type === "agent" ? (
                            <LuBot className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                          ) : comment.author_type === "system" ? (
                            <LuSparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <LuUser className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate font-semibold text-foreground">{comment.author}</span>
                          <span className="text-muted-foreground/50" aria-hidden>
                            ·
                          </span>
                          <RepositoryTimestamp value={comment.created_at} prefix="" />
                        </div>
                        {comment.conversation_id && comment.author_type !== "user" && (
                          <button
                            type="button"
                            onClick={() => openAgentChat(comment.conversation_id as string)}
                            className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            {t("issues.openChat")}
                          </button>
                        )}
                      </div>
                      <div className="p-4">
                        <IssueMarkdown>{comment.body || t("common.emptyComment")}</IssueMarkdown>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={submitComment} className="space-y-2">
                <Textarea
                  rows={3}
                  value={commentBody}
                  aria-label={t("issues.commentLabel")}
                  placeholder={t("issues.commentPlaceholder")}
                  onChange={(event) => setCommentBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void submitComment(event as unknown as React.FormEvent);
                    }
                  }}
                  className="resize-y"
                />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" loading={posting} disabled={!commentBody.trim()} className="gap-1.5 text-xs">
                    <LuSend className="h-3.5 w-3.5" />
                    {t("issues.comment")}
                  </Button>
                </div>
              </form>
            </div>
          </div>

          <div className="space-y-5 lg:border-l lg:border-border lg:pl-6">
            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("issues.statusLabel")}
              </h4>
              <Select value={issue.status} onValueChange={(value) => void applyUpdate({ status: value as IssueStatus })}>
                <SelectTrigger aria-label={t("issues.statusLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`issues.statusNames.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("issues.priorityLabel")}
              </h4>
              <Select value={issue.priority} onValueChange={(value) => void applyUpdate({ priority: value as IssuePriority })}>
                <SelectTrigger aria-label={t("issues.priorityLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`issues.priorityNames.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("common.labels")}
              </h4>
              {issue.labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {issue.labels.map((label) => (
                    <IssueLabelChip
                      key={label.name}
                      label={label}
                      onRemove={() =>
                        void applyUpdate({ labels: issue.labels.filter((item) => item.name !== label.name) })
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/70">{t("common.noneYet")}</p>
              )}
              <Input
                value={labelDraft}
                aria-label={t("issues.addLabel")}
                placeholder={t("issues.addLabel")}
                onChange={(event) => setLabelDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addLabels();
                  }
                }}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("issues.agent")}
              </h4>
              {issue.assigned_to_agent ? (
                <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    {agentActive ? (
                      <LuLoaderCircle className="h-3.5 w-3.5 animate-spin text-amber-500" />
                    ) : (
                      <LuBot className="h-3.5 w-3.5 text-indigo-500" />
                    )}
                    {agentActive ? t("issues.agentWorking") : t("issues.agentAssigned")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {issue.agent_conversation_id && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => openAgentChat(issue.agent_conversation_id as string)}
                      >
                        {t("issues.openChat")}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void unassignAgent()}>
                      {t("issues.unassignAgent")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  loading={launching}
                  disabled={launching || issue.state === "closed"}
                  onClick={() => void assignToAgent()}
                  className="w-full gap-1.5 text-xs"
                >
                  <LuSparkles className="h-3.5 w-3.5" />
                  {launching ? t("issues.assigningAgent") : t("issues.assignAgent")}
                </Button>
              )}
              {!issue.assigned_to_agent && issue.state === "closed" && (
                <p className="text-[11px] text-muted-foreground/70">{t("issues.reopenToAssign")}</p>
              )}
            </div>

            {(issue.branch || issue.pr_url) && (
              <div className="space-y-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("issues.work")}
                </h4>
                {issue.branch && (
                  <p className="flex items-center gap-1.5 break-all font-mono text-xs text-foreground">
                    <LuGitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {issue.branch}
                  </p>
                )}
                {issue.pr_url && (
                  <a
                    href={issue.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    <LuGitPullRequest className="h-3.5 w-3.5" />
                    {issue.pr_number ? t("issues.pullRequestNumber", { number: issue.pr_number }) : t("issues.pullRequest")}
                    <LuExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
