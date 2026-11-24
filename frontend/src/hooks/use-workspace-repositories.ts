"use client";

import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import { isNoActiveVM, repositoryError, repositoryRequest, type WorkspaceRepository } from "@/lib/repository-api";

const useSelection = create<{ paths: Record<string, string>; select: (uuid: string, path: string) => void }>((set) => ({
  paths: {},
  select: (uuid, path) => set((state) => ({ paths: { ...state.paths, [uuid]: path } })),
}));

function repositoriesEqual(a: WorkspaceRepository[], b: WorkspaceRepository[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].path !== b[i].path ||
      a[i].name !== b[i].name ||
      a[i].github_repository !== b[i].github_repository ||
      a[i].remote_url !== b[i].remote_url
    ) {
      return false;
    }
  }
  return true;
}

export function useWorkspaceRepositories() {
  const uuid = useSandboxProjectsStore((state) => state.workspaceSandbox?.uuid);
  const projectPath = useSandboxProjectsStore((state) => state.currentSandbox?.filesystem_path);
  const files = useSandboxProjectsStore((state) => state.files);
  const isVMRunning = true;
  const selectionKey = `${uuid}:${projectPath || "/workspace"}`;
  const selectedPath = useSelection((state) => uuid ? state.paths[selectionKey] : undefined);
  const select = useSelection((state) => state.select);
  const [result, setResult] = useState<{ uuid?: string; repositories: WorkspaceRepository[]; error: string | null }>({ repositories: [], error: null });
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!uuid || !isVMRunning) {
      setLoading(false);
      setResult({ uuid, repositories: [], error: null });
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setResult((previous) => ({ uuid, repositories: previous.uuid === uuid ? previous.repositories : [], error: null }));
    repositoryRequest<{ repositories: WorkspaceRepository[] }>(uuid, "git/repositories", {}, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult((previous) => {
          if (previous.uuid === uuid && previous.error === null && repositoriesEqual(previous.repositories, data.repositories)) {
            return previous;
          }
          return { uuid, repositories: data.repositories, error: null };
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (isNoActiveVM(error)) {
          setResult({ uuid, repositories: [], error: null });
        } else {
          setResult((previous) => {
            if (previous.uuid === uuid && previous.repositories.length > 0) {
              return previous;
            }
            return { uuid, repositories: [], error: repositoryError(error) };
          });
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [uuid, isVMRunning, revision, files]);

  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const removeRepository = useCallback((path: string) => {
    setResult(previous => previous.uuid === uuid
      ? { ...previous, repositories: previous.repositories.filter(item => item.path !== path) }
      : previous);
    refresh();
  }, [uuid, refresh]);

  const repositories = (result.uuid === uuid ? result.repositories : []).filter(item => !projectPath || projectPath === "/workspace" || item.path === projectPath || item.path.startsWith(`${projectPath.replace(/\/$/, "")}/`));
  const repository = repositories.find((item) => item.path === selectedPath) || repositories.find((item) => item.path === projectPath) || repositories[0];
  const hasCachedForUuid = result.uuid === uuid && result.repositories.length > 0;
  return {
    uuid,
    repositories,
    repository,
    isLoading: (loading && !hasCachedForUuid) || Boolean(uuid && result.uuid !== uuid),
    isRefreshing: loading,
    error: result.uuid === uuid ? result.error : null,
    selectRepository: (path: string) => { if (uuid) select(selectionKey, path); },
    refresh,
    removeRepository,
  };
}
