import { env } from "@/lib/env";
import { authedAxios } from "@/lib/axios";

const API_BASE = env.API_URL || "";
export interface WorkspaceRepository {
  path: string;
  name: string;
  github_repository: string | null;
  remote_url: string | null;
}
export interface RepositoryChange {
  path: string;
  previous_path: string | null;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
  staged: boolean;
  index_status: string;
  worktree_status: string;
}
export interface RepositoryStatus extends WorkspaceRepository {
  branch: string;
  branches: { name: string; remote: boolean }[];
  head_commit: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  files: RepositoryChange[];
  history: { hash: string; subject: string; author: string; date: string }[];
  history_has_next: boolean;
  history_next_offset: number | null;
  total_commits?: number;
}
export interface RepositoryHistory {
  history: RepositoryStatus["history"];
  head_commit: string;
  has_next: boolean;
  next_offset: number | null;
  total_commits?: number;
}
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged" | "draft";
  draft?: boolean;
  author: string;
  author_avatar?: string;
  created_at?: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  head: string;
  head_sha?: string;
  base: string;
  base_sha?: string;
  body: string;
  labels?: IssueLabel[];
  assignees?: IssueAssignee[];
  comments?: number;
}
export interface PullRequestsResponse {
  repository: string | null;
  pull_requests: PullRequest[];
  has_next: boolean;
}
export interface PullRequestDetailData extends PullRequest {
  requested_reviewers?: IssueAssignee[];
  milestone?: IssueMilestone | null;
  commits_count?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments_count?: number;
  review_comments_count?: number;
  mergeable?: boolean | null;
  mergeable_state?: string;
}
export interface PullRequestDetailResponse {
  repository: string | null;
  pull_request: PullRequestDetailData;
}
export interface PullRequestFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}
export interface PullRequestFilesResponse {
  repository: string | null;
  pull_number: number;
  files: PullRequestFile[];
}
export interface PullRequestCommit {
  sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_login: string;
  author_avatar?: string;
  date: string;
  url: string;
}
export interface PullRequestCommitsResponse {
  repository: string | null;
  pull_number: number;
  commits: PullRequestCommit[];
}
export interface PullRequestComment {
  id: number;
  url: string;
  author: string;
  author_avatar?: string;
  created_at: string;
  updated_at?: string;
  body: string;
  type?: "issue_comment" | "review_comment";
  path?: string;
  line?: number;
  diff_hunk?: string;
}
export interface PullRequestCommentsResponse {
  repository: string | null;
  pull_number: number;
  comments: PullRequestComment[];
}
export interface PullRequestCheck {
  id: number;
  name: string;
  status: "completed" | "in_progress" | "queued" | string;
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | string | null;
  url?: string;
  started_at?: string;
  completed_at?: string;
}
export interface PullRequestChecksResponse {
  repository: string | null;
  pull_number: number;
  head_sha?: string;
  total_count: number;
  checks: PullRequestCheck[];
}
export interface IssueLabel {
  name: string;
  color: string;
  description?: string;
}
export interface IssueAssignee {
  login: string;
  avatar_url: string;
}
export interface IssueMilestone {
  title: string;
  state?: string;
  due_on?: string | null;
}
export interface IssueComment {
  id: number;
  url: string;
  author: string;
  author_avatar?: string;
  created_at: string;
  updated_at?: string;
  body: string;
}
export interface IssueCommentsResponse {
  repository: string | null;
  issue_number: number;
  comments: IssueComment[];
}
export interface Issue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | string | null;
  author: string;
  author_avatar?: string;
  assignees?: IssueAssignee[];
  milestone?: IssueMilestone | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  body: string;
  comments: number;
  labels: IssueLabel[];
}
export interface IssuesResponse {
  repository: string | null;
  issues: Issue[];
  has_next: boolean;
}
export interface IssueDetailResponse {
  repository: string | null;
  issue: Issue | null;
}
export async function repositoryRequest<T>(uuid: string, endpoint: string, params: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
  const { data } = await authedAxios.get<T>(`${API_BASE}/sandbox/sandboxes/${uuid}/${endpoint}/`, { params, signal });
  return data;
}
export function repositoryError(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string; detail?: string } } })?.response?.data;
  return data?.error || data?.detail || "Could not load repository data. Try again.";
}
export function repositoryUnavailable(error: unknown): boolean {
  return (error as { response?: { data?: { code?: string } } })?.response?.data?.code === "repository_unavailable";
}
export function isNoActiveVM(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    return error.toLowerCase().includes("virtual machine") || error.toLowerCase().includes("no active vm");
  }
  const err = error as { response?: { status?: number; data?: { code?: string; error?: string } } };
  return (
    err?.response?.status === 412 ||
    err?.response?.data?.code === "no_active_vm" ||
    Boolean(err?.response?.data?.error?.toLowerCase().includes("virtual machine"))
  );
}
export async function repositoryMutation<T>(uuid: string, endpoint: string, data: Record<string, unknown>): Promise<T> {
  const response = await authedAxios.post<T>(`${API_BASE}/sandbox/sandboxes/${uuid}/${endpoint}/`, data);
  return response.data;
}

/** The checkout one chat works in: its private branch worktree, or the project folder until it picks a branch. */
export interface ChatCheckout extends RepositoryStatus {
  worktree_path: string;
}
export async function chatCheckoutRequest(uuid: string, conversationId: string, path: string, signal?: AbortSignal): Promise<ChatCheckout> {
  const { data } = await authedAxios.get<ChatCheckout>(`${API_BASE}/sandbox/sandboxes/${uuid}/git/worktree/`, {
    params: { conversation_id: conversationId, path },
    signal,
  });
  return data;
}
export function chatCheckoutSwitch(uuid: string, conversationId: string, path: string, branch: string, create = false): Promise<ChatCheckout> {
  return repositoryMutation<ChatCheckout>(uuid, "git/worktree", { conversation_id: conversationId, path, branch, create });
}
