/** Pure helpers for turning an issue into an agent session. Kept free of store imports so they are easy to test. */

export interface PromptIssue {
  number: number;
  title: string;
  body: string;
  labels?: Array<{ name: string }>;
  branch?: string;
}

export interface PromptComment {
  author: string;
  author_type: "user" | "agent" | "system" | "import";
  body: string;
}

const MAX_BRANCH_SLUG = 40;
const MAX_COMMENTS = 10;
const MAX_COMMENT_CHARS = 1500;
const MAX_BODY_CHARS = 8000;

export function issueBranchName(issue: Pick<PromptIssue, "number" | "title">): string {
  const slug = issue.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SLUG)
    .replace(/-+$/g, "");
  return slug ? `issue-${issue.number}-${slug}` : `issue-${issue.number}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildIssueAgentPrompt(
  issue: PromptIssue,
  comments: PromptComment[],
  options: { branch?: string | null; environmentName?: string } = {}
): string {
  const lines: string[] = [`Work on issue #${issue.number}: ${issue.title}`, ""];

  if (options.environmentName) lines.push(`Environment: ${options.environmentName}`);
  if (issue.labels && issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.map((label) => label.name).join(", ")}`);
  }
  lines.push("", "## Description", issue.body.trim() ? truncate(issue.body.trim(), MAX_BODY_CHARS) : "(no description)");

  const discussion = comments.filter((comment) => comment.author_type !== "system").slice(-MAX_COMMENTS);
  if (discussion.length > 0) {
    lines.push("", "## Discussion");
    for (const comment of discussion) {
      lines.push(`- ${comment.author}: ${truncate(comment.body.trim().replace(/\s+/g, " "), MAX_COMMENT_CHARS)}`);
    }
  }

  lines.push("", "## Instructions");
  if (options.branch) {
    lines.push(`- You are working on the branch \`${options.branch}\`. Keep all changes for this issue on it.`);
  }
  lines.push(
    "- Investigate the codebase, implement the fix or feature, and verify it (run the relevant tests or checks).",
    "- Commit your work with clear messages and push the branch when it is ready.",
    `- Report progress with the issue tools: add a comment to issue #${issue.number} summarising what you did, ` +
      `and when the change is ready set its status to "in_review" with the branch and pull request URL.`,
    "- If you are blocked or need a decision, comment on the issue and ask instead of guessing."
  );
  return lines.join("\n");
}
