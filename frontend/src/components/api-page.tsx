import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { authedAxios, API_BASE } from "@/lib/axios";
import { Button } from "@/components/ui/button";
import { LoadingDots } from "@/components/loading-dots";
import NotFound from "@/app/not-found";

/** Load public detail pages in the browser, including deep links and retries. */
export function ApiPage<T>({ path, children }: { path: string; children: (data: T) => ReactNode }) {
  const { t } = useTranslation("docs");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ path: string; data?: T; status?: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    void authedAxios.get<T>(`${API_BASE}${path}`, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setResult({ path, data }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ path, status: error.response?.status || 500 }); });
    return () => controller.abort();
  }, [path, attempt]);
  if (result?.path === path && result.status === 404) return <NotFound />;
  if (result?.path === path && result.status) return <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center"><p className="text-sm text-muted-foreground">{t("apiPage.loadError")}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>{t("apiPage.tryAgain")}</Button></div>;
  if (result?.path !== path || !result.data) return <div role="status" aria-label={t("apiPage.loading")} className="flex min-h-64 items-center justify-center"><LoadingDots /></div>;
  return children(result.data);
}
