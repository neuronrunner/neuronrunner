import { env } from "@/lib/env";
import { authedAxios } from "@/lib/axios";

const API_BASE = env.API_URL || "";

export type IssueStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export type IssuePriority = "none" | "low" | "medium" | "high" | "urgent";
export type IssueStateFilter = "open" | "closed";

export const ISSUE_STATUSES: IssueStatus[] = ["todo", "in_progress", "in_review", "done", "cancelled"];
export const ISSUE_PRIORITIES: IssuePriority[] = ["none", "low", "medium", "high", "urgent"];

export interface IssueLabel {
  name: string;
  color: string;
}

export interface Issue {
  id: string;
  number: number;
  environment_id: string;
  title: string;
  body: string;
  status: IssueStatus;
  state: IssueStateFilter;
  priority: IssuePriority;
  labels: IssueLabel[];
  creator: { type: "user" | "agent" | "import"; name: string };
  assignee: { id: string; name: string } | null;
  assigned_to_agent: boolean;
  agent_conversation_id: string | null;
  branch: string;
  pr_url: string;
  pr_number: number | null;
  external: { source: "github" | "gitlab"; id: string; url: string; author: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IssueComment {
  id: string;
  author: string;
  author_type: "user" | "agent" | "system" | "import";
  body: string;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueCounts {
  open: number;
  closed: number;
}

export interface IssuesResponse {
  environment_id: string;
  issues: Issue[];
  has_next: boolean;
  /** Totals for the whole environment, independent of the current filter or search. */
  counts?: IssueCounts;
}

export interface ListIssuesParams {
  state?: IssueStateFilter | "all";
  status?: IssueStatus;
  q?: string;
  page?: number;
  per_page?: number;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  priority?: IssuePriority;
  labels?: Array<string | IssueLabel>;
  status?: IssueStatus;
}

export type UpdateIssueInput = Partial<Pick<Issue, "title" | "body" | "status" | "priority" | "labels">>;

export type ImportProvider = "github" | "gitlab";

export interface ImportIssuesResult {
  provider: ImportProvider;
  imported: number;
  skipped: number;
  truncated: boolean;
}

export function issuesUrl(environmentId: string, ...parts: Array<string | number>): string {
  const tail = parts.map((part) => `${part}/`).join("");
  return `${API_BASE}/issues/environments/${environmentId}/${tail}`;
}

export function issuesError(error: unknown, fallback = "Something went wrong. Try again."): string {
  const data = (error as { response?: { data?: { error?: string; detail?: string } } })?.response?.data;
  return data?.error || data?.detail || fallback;
}

export function issuesErrorCode(error: unknown): string | undefined {
  return (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
}

export async function listIssues(
  environmentId: string,
  params: ListIssuesParams = {},
  signal?: AbortSignal
): Promise<IssuesResponse> {
  const query: Record<string, string | number> = {};
  if (params.state) query.state = params.state;
  if (params.status) query.status = params.status;
  if (params.q?.trim()) query.q = params.q.trim();
  if (params.page) query.page = params.page;
  if (params.per_page) query.per_page = params.per_page;
  const { data } = await authedAxios.get<IssuesResponse>(issuesUrl(environmentId), { params: query, signal });
  return data;
}

export async function getIssue(environmentId: string, number: number, signal?: AbortSignal): Promise<Issue> {
  const { data } = await authedAxios.get<{ issue: Issue }>(issuesUrl(environmentId, number), { signal });
  return data.issue;
}

export async function createIssue(environmentId: string, input: CreateIssueInput): Promise<Issue> {
  const { data } = await authedAxios.post<{ issue: Issue }>(issuesUrl(environmentId), input);
  return data.issue;
}

export async function updateIssue(environmentId: string, number: number, input: UpdateIssueInput): Promise<Issue> {
  const { data } = await authedAxios.patch<{ issue: Issue }>(issuesUrl(environmentId, number), input);
  return data.issue;
}

export async function deleteIssue(environmentId: string, number: number): Promise<void> {
  await authedAxios.delete(issuesUrl(environmentId, number));
}

export async function listIssueComments(
  environmentId: string,
  number: number,
  signal?: AbortSignal
): Promise<IssueComment[]> {
  const { data } = await authedAxios.get<{ comments: IssueComment[] }>(issuesUrl(environmentId, number, "comments"), {
    signal,
  });
  return data.comments;
}

export async function addIssueComment(environmentId: string, number: number, body: string): Promise<IssueComment> {
  const { data } = await authedAxios.post<{ comment: IssueComment }>(issuesUrl(environmentId, number, "comments"), {
    body,
  });
  return data.comment;
}

export async function assignIssueAgent(
  environmentId: string,
  number: number,
  input: { conversation_id: string; branch?: string }
): Promise<Issue> {
  const { data } = await authedAxios.post<{ issue: Issue }>(issuesUrl(environmentId, number, "assign-agent"), input);
  return data.issue;
}

export async function unassignIssueAgent(environmentId: string, number: number): Promise<Issue> {
  const { data } = await authedAxios.post<{ issue: Issue }>(issuesUrl(environmentId, number, "unassign-agent"), {});
  return data.issue;
}

export async function importIssues(
  environmentId: string,
  input: { provider?: ImportProvider; state?: IssueStateFilter | "all" }
): Promise<ImportIssuesResult> {
  const { data } = await authedAxios.post<ImportIssuesResult>(issuesUrl(environmentId, "import"), input);
  return data;
}
