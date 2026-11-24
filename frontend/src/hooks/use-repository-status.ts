"use client";

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { isNoActiveVM, repositoryError, repositoryMutation, repositoryRequest, type RepositoryStatus } from "@/lib/repository-api";
import useSandboxProjectsStore from "@/stores/sandbox-projects";

const statusCache = new Map<string, RepositoryStatus>();

export const useRepositoryChanges = create<{ revisions: Record<string, number>; changed: (key: string) => void }>(set => ({
  revisions: {},
  changed: key => set(state => ({ revisions: { ...state.revisions, [key]: (state.revisions[key] || 0) + 1 } })),
}));

export function useRepositoryStatus(uuid?: string, path?: string) {
  const key = `${uuid}:${path}`;
  const revision = useRepositoryChanges(state => state.revisions[key] || 0);
  const current = useRef(key);
  current.current = key;
  const pending = useRef(false);

  const isVMRunning = true;

  const [result, setResult] = useState<{ key: string; status?: RepositoryStatus; error?: string }>(() => ({
    key,
    status: statusCache.get(key),
  }));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(uuid && path && isVMRunning && !statusCache.get(key)));

  useEffect(() => {
    if (!uuid || !path || !isVMRunning) {
      setLoading(false);
      setResult(previous => {
        const cached = statusCache.get(key);
        if (previous.key === key && previous.status) return { ...previous, error: undefined };
        if (cached) return { key, status: cached, error: undefined };
        return { key, error: undefined };
      });
      return;
    }
    const controller = new AbortController();
    const cached = statusCache.get(key);
    if (!cached) {
      setLoading(true);
    }
    setResult(previous => {
      if (previous.key === key && previous.status) return previous;
      if (cached) return { key, status: cached };
      return { key };
    });
    repositoryRequest<RepositoryStatus>(uuid, "git/repository", { path }, controller.signal)
      .then(status => {
        if (!controller.signal.aborted) {
          statusCache.set(key, status);
          setResult({ key, status, error: undefined });
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          const cached = statusCache.get(key);
          if (isNoActiveVM(error)) {
            setResult({
              key,
              status: cached,
              error: undefined,
            });
          } else {
            setResult({
              key,
              status: cached,
              error: repositoryError(error),
            });
          }
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [uuid, path, key, revision, isVMRunning]);

  const status = result.key === key ? result.status : undefined;
  const error = result.key === key ? result.error : undefined;

  const switchBranch = async (branch: string, create = false) => {
    if (!uuid || !path || !status || !isVMRunning || pending.current) return false;
    pending.current = true;
    setBusy(true);
    try {
      const next = branch === status.branch && !create
        ? status
        : await repositoryMutation<RepositoryStatus>(uuid, "git/switch", { path, branch, create });
      statusCache.set(key, next);
      useRepositoryChanges.getState().changed(key);
      const store = useSandboxProjectsStore.getState();
      if (store.workspaceSandbox?.uuid === uuid) void store.fetchFiles(uuid);
      if (current.current !== key) return false;
      setResult({ key, status: next });
      return true;
    } catch (cause) {
      if (current.current === key) {
        if (isNoActiveVM(cause)) {
          setResult({ key, status, error: undefined });
        } else {
          setResult({ key, status, error: repositoryError(cause) });
        }
      }
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return {
    status,
    error,
    busy,
    loading,
    isVMRunning,
    switchBranch,
    refresh: () => useRepositoryChanges.getState().changed(key),
  };
}
