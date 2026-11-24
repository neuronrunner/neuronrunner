"use client";

import { useEffect } from "react";
import useNavbarStore from "@/stores/navbar";
import { SEO } from "@/components/seo";
import { useTranslation } from "react-i18next";

export default function Page404() {
  const { t } = useTranslation("auth");
  const setIsNotFound = useNavbarStore((state) => state.setIsNotFound);

  useEffect(() => {
    setIsNotFound(true);
    return () => setIsNotFound(false);
  }, [setIsNotFound]);

  return (
    <div className="flex justify-center items-center min-h-[calc(100dvh-80px)] px-4">
      <SEO title={t("notFound.seoTitle")} noindex={true} />
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
        404
      </h1>
      <div className="mx-4 h-10 w-[1px] bg-slate-300 dark:bg-white/20" />
      <p className="text-base sm:text-lg text-slate-500 dark:text-slate-400">
        {t("notFound.description")}
      </p>
    </div>
  );
}
