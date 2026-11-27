"use client";

import {
  assignIssueAgent,
  type Issue,
  type IssueComment,
} from "@/lib/issues-api";
import { buildIssueAgentPrompt, issueBranchName } from "@/lib/issue-prompt";
import { useChatBranchStore } from "@/stores/chat-branch";
import useChatStore from "@/stores/chat";
import useSandboxProjectsStore, { type IProject } from "@/stores/sandbox-projects";

export interface LaunchIssueAgentParams {
  issue: Issue;
  comments: IssueComment[];
  environment: IProject;
}

export interface LaunchIssueAgentResult {
  conversationId: string;
  issue: Issue;
  branch: string | null;
}

// Only one launch may own the shared chat store at a time (same constraint as git AI sessions).
let activeLaunchNonce = 0;

/**
 * Starts an agent session for an issue and links it back to the issue.
 *
 * The run itself is created by the normal chat flow (`useChatStore.sendMessage`) so model selection,
 * billing and streaming behave exactly like a regular chat. The issue is linked as soon as the server
 * reports the new conversation id, without waiting for the agent to finish.
 */
export async function launchIssueAgent(params: LaunchIssueAgentParams): Promise<LaunchIssueAgentResult> {
  const { issue, comments, environment } = params;
  const nonce = ++activeLaunchNonce;

  const picked = await useSandboxProjectsStore.getState().pickSandbox(environment.uuid);
  if (!picked) {
    throw new Error("Could not select the environment for this issue.");
  }
  if (nonce !== activeLaunchNonce) {
    throw new Error("Another agent session was started.");
  }

  // Work on a dedicated branch (its own worktree) whenever the environment is repo-backed.
  const branch = environment.repo_full_name || environment.repo_url ? issue.branch || issueBranchName(issue) : null;
  const createBranch = !issue.branch;
  const prompt = buildIssueAgentPrompt(issue, comments, {
    branch,
    environmentName: environment.display_name || environment.slug,
  });

  const chatStore = useChatStore.getState();
  chatStore.setChatMode("code");
  chatStore.reset();
  if (branch) {
    useChatBranchStore.getState().setPending({ project: environment.uuid, branch, create: createBranch });
  }

  return new Promise<LaunchIssueAgentResult>((resolve, reject) => {
    let settled = false;
    let linking: Promise<void> | null = null;

    const link = (conversationId: string) => {
      if (linking) return linking;
      linking = assignIssueAgent(environment.uuid, issue.number, {
        conversation_id: conversationId,
        ...(branch ? { branch } : {}),
      })
        .then((updated) => {
          settled = true;
          unsubscribe();
          resolve({ conversationId, issue: updated, branch });
        })
        .catch((error) => {
          settled = true;
          unsubscribe();
          reject(error);
        });
      return linking;
    };

    const unsubscribe = useChatStore.subscribe((state) => {
      if (settled || nonce !== activeLaunchNonce) return;
      if (state.conversationId) void link(state.conversationId);
    });

    useChatStore
      .getState()
      .sendMessage(prompt)
      .then((conversationId) => {
        if (settled || linking) return;
        if (conversationId) {
          void link(conversationId);
        } else {
          settled = true;
          unsubscribe();
          reject(new Error(useChatStore.getState().error || "The agent could not be started."));
        }
      })
      .catch((error) => {
        if (settled || linking) return;
        settled = true;
        unsubscribe();
        reject(error);
      });
  });
}
