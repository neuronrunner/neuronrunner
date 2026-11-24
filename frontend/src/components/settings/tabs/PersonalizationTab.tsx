"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  LuTrash2,
  LuPencil,
  LuCheck,
  LuX,
  LuPlus,
  LuSearch,
  LuSparkles,
  LuCopy,
  LuBrain,
  LuFileText,
  LuTag,
  LuClock,
  LuShieldCheck,
  LuChevronDown,
  LuChevronUp,
} from "react-icons/lu";
import useAuthStore from "@/stores/auth";
import useSettingsStore from "@/stores/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MEMORY_CATEGORY_STYLES = {
  identity: {
    color: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/20",
    dot: "bg-purple-500",
  },
  preference: {
    color: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-500",
  },
  workspace: {
    color: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
    dot: "bg-blue-500",
  },
  knowledge: {
    color: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20",
    dot: "bg-amber-500",
  },
  relationship: {
    color: "bg-pink-500/15 text-pink-600 dark:text-pink-400 border-pink-500/20",
    dot: "bg-pink-500",
  },
} as const;

const QUICK_TEMPLATE_META = [
  {
    key: "languageTone",
    category: "preference",
    label: "language",
    importance: 9,
  },
  {
    key: "roleStack",
    category: "identity",
    label: "role",
    importance: 8,
  },
  {
    key: "codeStyle",
    category: "workspace",
    label: "coding-style",
    importance: 8,
  },
  {
    key: "architecture",
    category: "knowledge",
    label: "architecture",
    importance: 7,
  },
] as const;

function formatRelativeDate(iso?: string | null, locale: string = "en") {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getImportanceLabel(score: number, t: TFunction<"settings">) {
  if (score >= 8) return { text: t("personalization.importance.core"), className: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20" };
  if (score >= 5) return { text: t("personalization.importance.standard"), className: "text-muted-foreground bg-muted/60 border-border" };
  return { text: t("personalization.importance.low"), className: "text-muted-foreground/70 bg-muted/30 border-border/60" };
}

export default function PersonalizationTab() {
  const { t, i18n } = useTranslation("settings");
  const dateLocale = i18n.resolvedLanguage || "en";
  const auth = useAuthStore();
  const hasHydrated = useRef(false);
  const hasShownInitial = useRef(false);

  const [activeStoreTab, setActiveStoreTab] = useState<"memories" | "notes">("memories");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [showSnapshot, setShowSnapshot] = useState<boolean>(true);
  const [copiedSnapshot, setCopiedSnapshot] = useState<boolean>(false);

  // Add form state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<string>("preference");
  const [newLabel, setNewLabel] = useState<string>("");
  const [newImportance, setNewImportance] = useState<number>(7);
  const [isSubmittingNew, setIsSubmittingNew] = useState(false);

  // Edit form state
  const [isDeleteAllDialogOpen, setIsDeleteAllDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<string>("");
  const [editLabel, setEditLabel] = useState<string>("");
  const [editImportance, setEditImportance] = useState<number>(5);

  const lastSaved = useRef({
    preferredName: "",
    memoryEnabled: true,
  });

  const {
    preferredName,
    setPreferredName,
    memoryEnabled,
    setMemoryEnabled,
    memories,
    memoriesLoading,
    fetchMemories,
    addMemory,
    updateMemory,
    deleteMemory,
    deleteAllMemories,
    notes,
    notesLoading,
    fetchNotes,
    addNote,
    updateNote,
    deleteNote,
    hydrating,
    setHydrating,
    hydrateProfile,
    savePersonalization,
  } = useSettingsStore();

  useEffect(() => {
    if (hasHydrated.current) return;
    if (auth.token && !hasHydrated.current) {
      hasHydrated.current = true;
      hydrateProfile(auth.token);
      fetchMemories(auth.token);
      fetchNotes(auth.token);
    } else {
      setHydrating(false);
    }
  }, [auth.token, hydrateProfile, fetchMemories, fetchNotes, setHydrating]);

  useEffect(() => {
    if (hydrating || hasShownInitial.current) return;
    hasShownInitial.current = true;
    lastSaved.current = {
      preferredName,
      memoryEnabled,
    };
  }, [hydrating, preferredName, memoryEnabled]);

  const persistPersonalization = (forceMemoryEnabled?: boolean) => {
    const token = auth.token || "";
    if (!token) return;

    const nextMemoryEnabled = forceMemoryEnabled !== undefined ? forceMemoryEnabled : memoryEnabled;
    const hasChanges =
      lastSaved.current.preferredName !== preferredName ||
      lastSaved.current.memoryEnabled !== nextMemoryEnabled;

    if (!hasChanges) return;

    savePersonalization(token).then(() => {
      lastSaved.current = {
        preferredName,
        memoryEnabled: nextMemoryEnabled,
      };
    });
  };

  // Synthesize Claude-style profile overview from memories
  const synthesizedProfile = useMemo(() => {
    const groups: Record<string, typeof memories> = {
      identity: [],
      preference: [],
      workspace: [],
      knowledge: [],
      relationship: [],
      other: [],
    };
    const sorted = [...memories].sort((a, b) => b.importance_score - a.importance_score);
    for (const m of sorted) {
      const key = m.category && groups[m.category] ? m.category : "other";
      groups[key].push(m);
    }
    return groups;
  }, [memories]);

  const coreCount = useMemo(
    () => memories.filter((m) => m.importance_score >= 8).length,
    [memories]
  );

  const memoryCategories = useMemo(() => {
    const result: Record<string, { label: string; description: string; color: string; dot: string }> = {};
    for (const key of Object.keys(MEMORY_CATEGORY_STYLES) as Array<keyof typeof MEMORY_CATEGORY_STYLES>) {
      const styles = MEMORY_CATEGORY_STYLES[key];
      result[key] = {
        ...styles,
        label: t(`personalization.categories.${key}.label`),
        description: t(`personalization.categories.${key}.description`),
      };
    }
    return result;
  }, [t]);

  const quickTemplates = useMemo(
    () =>
      QUICK_TEMPLATE_META.map((tpl) => ({
        ...tpl,
        title: t(`personalization.templates.${tpl.key}.title`),
        sample: t(`personalization.templates.${tpl.key}.sample`),
      })),
    [t]
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: memories.length };
    for (const key of Object.keys(MEMORY_CATEGORY_STYLES)) counts[key] = 0;
    for (const m of memories) {
      if (m.category && counts[m.category] !== undefined) {
        counts[m.category] += 1;
      }
    }
    return counts;
  }, [memories]);

  const filteredMemories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return memories.filter((m) => {
      if (selectedCategory !== "all" && m.category !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      return (
        m.content.toLowerCase().includes(q) ||
        (m.label && m.label.toLowerCase().includes(q)) ||
        (m.category && m.category.toLowerCase().includes(q))
      );
    });
  }, [memories, selectedCategory, searchQuery]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return notes.filter((n) => {
      if (!q) return true;
      return (
        n.content.toLowerCase().includes(q) ||
        (n.category && n.category.toLowerCase().includes(q))
      );
    });
  }, [notes, searchQuery]);

  const copyMarkdownProfile = () => {
    const lines: string[] = [t("personalization.markdown.title")];
    if (preferredName) {
      lines.push(`\n${t("personalization.markdown.preferredName", { name: preferredName })}`);
    }
    for (const [cat, meta] of Object.entries(memoryCategories)) {
      const items = synthesizedProfile[cat] || [];
      if (items.length === 0) continue;
      lines.push(`\n## ${meta.label}`);
      for (const item of items) {
        const tag = item.label ? ` [${item.label}]` : "";
        lines.push(`- ${item.content}${tag}`);
      }
    }
    if (synthesizedProfile.other.length > 0) {
      lines.push(`\n## ${t("personalization.markdown.general")}`);
      for (const item of synthesizedProfile.other) {
        lines.push(`- ${item.content}`);
      }
    }
    navigator.clipboard.writeText(lines.join("\n"));
    setCopiedSnapshot(true);
    setTimeout(() => setCopiedSnapshot(false), 2000);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = auth.token || "";
    if (!token || !newContent.trim()) return;

    setIsSubmittingNew(true);
    try {
      if (activeStoreTab === "memories") {
        await addMemory(token, {
          content: newContent.trim(),
          category: newCategory || null,
          label: newLabel.trim() || null,
          importance_score: newImportance,
        });
      } else {
        await addNote(token, {
          content: newContent.trim(),
          category: newCategory || null,
          importance_score: newImportance,
        });
      }
      setNewContent("");
      setNewLabel("");
      setIsAddOpen(false);
    } finally {
      setIsSubmittingNew(false);
    }
  };

  const applyTemplate = (tpl: (typeof quickTemplates)[number]) => {
    setActiveStoreTab("memories");
    setIsAddOpen(true);
    setNewCategory(tpl.category);
    setNewLabel(tpl.label);
    setNewImportance(tpl.importance);
    setNewContent(tpl.sample);
  };

  const startEditMemory = (memory: {
    uuid: string;
    content: string;
    category: string | null;
    label?: string | null;
    importance_score: number;
  }) => {
    setEditingId(memory.uuid);
    setEditContent(memory.content);
    setEditCategory(memory.category || "");
    setEditLabel(memory.label || "");
    setEditImportance(memory.importance_score);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent("");
    setEditCategory("");
    setEditLabel("");
    setEditImportance(5);
  };

  const saveEdit = () => {
    const token = auth.token || "";
    if (!token || !editingId || !editContent.trim()) return;

    if (activeStoreTab === "memories") {
      updateMemory(token, editingId, {
        content: editContent.trim(),
        category: editCategory || null,
        label: editLabel.trim() || null,
        importance_score: editImportance,
      });
    } else {
      updateNote(token, editingId, {
        content: editContent.trim(),
        category: editCategory || null,
        importance_score: editImportance,
      });
    }
    cancelEdit();
  };

  const handleDeleteItem = (id: string) => {
    const token = auth.token || "";
    if (!token) return;
    if (activeStoreTab === "memories") {
      deleteMemory(token, id);
    } else {
      deleteNote(token, id);
    }
  };

  const confirmDeleteAll = () => {
    const token = auth.token || "";
    if (!token) return;
    deleteAllMemories(token);
    setIsDeleteAllDialogOpen(false);
  };

  return (
    <div className="max-w-3xl w-full space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground tracking-tight">
              {t("personalization.title")}
            </h2>
            <Badge
              className={cn(
                "text-[10px] px-2 py-0.5 font-medium rounded-full border",
                memoryEnabled
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                  : "bg-muted text-muted-foreground border-border"
              )}
            >
              {memoryEnabled ? t("personalization.memoryActive") : t("personalization.memoryPaused")}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("personalization.subtitle")}
          </p>
        </div>
      </div>

      {/* Preferences & Privacy Boundary Card */}
      <div className="p-5 rounded-2xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] space-y-4 shadow-sm dark:shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
          {/* Preferred Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("personalization.preferredName.label")}
            </label>
            {hydrating ? (
              <Skeleton className="h-9 w-full rounded-xl" />
            ) : (
              <Input
                value={preferredName}
                onChange={(e) => setPreferredName(e.target.value)}
                onBlur={() => persistPersonalization()}
                placeholder={t("personalization.preferredName.placeholder")}
                className="h-9 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-sm focus:border-ring focus:ring-1 focus:ring-ring"
              />
            )}
            <p className="text-[11px] text-muted-foreground/80">
              {t("personalization.preferredName.hint")}
            </p>
          </div>

          {/* Memory Toggle */}
          <div className="p-3.5 rounded-xl bg-muted/30 dark:bg-white/[0.02] border border-border/60 dark:border-white/5 flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <LuBrain className="h-3.5 w-3.5 text-primary" />
                <h4 className="text-xs font-semibold text-foreground">
                  {t("personalization.autoMemory.title")}
                </h4>
              </div>
              <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                {t("personalization.autoMemory.description")}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={memoryEnabled}
                onChange={(e) => {
                  setMemoryEnabled(e.target.checked);
                  persistPersonalization(e.target.checked);
                }}
                disabled={hydrating}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted-foreground/20 dark:bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-background after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-background dark:after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary dark:peer-checked:bg-zinc-200 shadow-inner"></div>
            </label>
          </div>
        </div>

        {/* Privacy Notice */}
        <div className="pt-3 border-t border-border dark:border-white/5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <LuShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            <span>
              <Trans
                ns="settings"
                i18nKey="personalization.privacyGuard"
                components={{ strong: <strong /> }}
              />
            </span>
          </div>
          <span className="hidden sm:inline text-[10px] font-mono text-muted-foreground/70">
            {t("personalization.recallEngine")}
          </span>
        </div>
      </div>

      {/* Claude-Style Synthesized Memory Profile Snapshot */}
      {memories.length > 0 && (
        <div className="rounded-2xl border border-border dark:border-white/10 bg-gradient-to-br from-card via-card to-muted/30 dark:from-white/[0.03] dark:to-white/[0.01] overflow-hidden shadow-sm dark:shadow-none">
          <div className="px-5 py-3.5 flex items-center justify-between border-b border-border/60 dark:border-white/5">
            <button
              type="button"
              onClick={() => setShowSnapshot((prev) => !prev)}
              className="flex items-center gap-2 text-left group"
            >
              <div className="h-6 w-6 rounded-lg bg-primary/10 dark:bg-white/10 flex items-center justify-center text-primary">
                <LuSparkles className="h-3.5 w-3.5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-foreground">
                    {t("personalization.snapshot.title")}
                  </h3>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 font-medium">
                    {t("personalization.snapshot.coreCount", { count: coreCount })}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("personalization.snapshot.subtitle")}
                </p>
              </div>
              {showSnapshot ? (
                <LuChevronUp className="h-4 w-4 text-muted-foreground ml-1" />
              ) : (
                <LuChevronDown className="h-4 w-4 text-muted-foreground ml-1" />
              )}
            </button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyMarkdownProfile}
              className="h-7 px-2.5 text-[11px] gap-1.5 rounded-lg border-border dark:border-white/10"
            >
              {copiedSnapshot ? (
                <>
                  <LuCheck className="h-3 w-3 text-emerald-500" />
                  <span>{t("personalization.snapshot.copied")}</span>
                </>
              ) : (
                <>
                  <LuCopy className="h-3 w-3" />
                  <span>{t("personalization.snapshot.copyMarkdown")}</span>
                </>
              )}
            </Button>
          </div>

          {showSnapshot && (
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(memoryCategories).map(([key, meta]) => {
                const items = synthesizedProfile[key] || [];
                if (items.length === 0) return null;
                return (
                  <div
                    key={key}
                    className="p-3 rounded-xl border border-border/70 dark:border-white/5 bg-background/60 dark:bg-black/20 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
                        <span className="text-[11px] font-semibold text-foreground">
                          {meta.label}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {items.length === 1
                          ? t("personalization.snapshot.factSingle", { count: items.length })
                          : t("personalization.snapshot.factPlural", { count: items.length })}
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {items.slice(0, 3).map((item) => (
                        <li
                          key={item.uuid}
                          className="text-xs text-muted-foreground leading-snug flex items-start gap-1.5"
                        >
                          <span className="text-muted-foreground/50 select-none">•</span>
                          <span className="line-clamp-2 text-foreground/90">{item.content}</span>
                        </li>
                      ))}
                      {items.length > 3 && (
                        <li className="text-[10px] text-muted-foreground/70 pl-2.5">
                          {t("personalization.snapshot.moreInCategory", {
                            count: items.length - 3,
                            category: meta.label.toLowerCase(),
                          })}
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Store Switcher Tabs + Action Controls */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Sub-tabs: Personal Memories vs Workspace Notes */}
          <div className="inline-flex p-1 rounded-xl bg-muted/60 dark:bg-white/[0.04] border border-border dark:border-white/10 w-fit">
            <button
              type="button"
              onClick={() => {
                setActiveStoreTab("memories");
                cancelEdit();
              }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                activeStoreTab === "memories"
                  ? "bg-background dark:bg-white/10 text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <LuBrain className="h-3.5 w-3.5" />
              <span>{t("personalization.tabs.memories")}</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-muted-foreground/15 text-foreground">
                {memories.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveStoreTab("notes");
                cancelEdit();
              }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                activeStoreTab === "notes"
                  ? "bg-background dark:bg-white/10 text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <LuFileText className="h-3.5 w-3.5" />
              <span>{t("personalization.tabs.notes")}</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-muted-foreground/15 text-foreground">
                {notes.length}
              </span>
            </button>
          </div>

          {/* Right Buttons: Add Memory & Delete All */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => setIsAddOpen((prev) => !prev)}
              className="h-8 rounded-xl text-xs gap-1.5"
            >
              <LuPlus className="h-3.5 w-3.5" />
              <span>
                {activeStoreTab === "memories"
                  ? t("personalization.actions.addMemory")
                  : t("personalization.actions.addNote")}
              </span>
            </Button>

            {activeStoreTab === "memories" && memories.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsDeleteAllDialogOpen(true)}
                className="text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-500/10 text-xs gap-1.5 h-8 rounded-xl"
              >
                <LuTrash2 className="h-3.5 w-3.5" />
                <span>{t("personalization.actions.clearAll")}</span>
              </Button>
            )}
          </div>
        </div>

        {/* Quick Templates Bar (when adding or when empty) */}
        {(isAddOpen || (activeStoreTab === "memories" && memories.length === 0)) && (
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <span className="text-[11px] text-muted-foreground mr-1">{t("personalization.quickTemplatesLabel")}</span>
            {quickTemplates.map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                onClick={() => applyTemplate(tpl)}
                className="text-[11px] px-2.5 py-1 rounded-full border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] hover:bg-muted dark:hover:bg-white/[0.06] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                <LuPlus className="h-2.5 w-2.5" />
                <span>{tpl.title}</span>
              </button>
            ))}
          </div>
        )}

        {/* Collapsible Add Memory / Note Form */}
        {isAddOpen && (
          <form
            onSubmit={handleAddSubmit}
            className="p-4 rounded-2xl border border-primary/30 dark:border-white/15 bg-muted/30 dark:bg-white/[0.03] space-y-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">
                {activeStoreTab === "memories"
                  ? t("personalization.addForm.newMemory")
                  : t("personalization.addForm.newNote")}
              </span>
              <button
                type="button"
                onClick={() => setIsAddOpen(false)}
                className="text-muted-foreground hover:text-foreground p-1 rounded-lg"
              >
                <LuX className="h-3.5 w-3.5" />
              </button>
            </div>

            <Input
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder={
                activeStoreTab === "memories"
                  ? t("personalization.addForm.memoryPlaceholder")
                  : t("personalization.addForm.notePlaceholder")
              }
              className="h-9 rounded-xl bg-card dark:bg-black/40 border-input dark:border-white/10 text-xs"
              autoFocus
            />

            <div className="flex items-center gap-2.5 flex-wrap">
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="h-8 px-2.5 rounded-xl bg-card dark:bg-black/40 border border-input dark:border-white/10 text-xs text-foreground outline-none"
              >
                <option value="">{t("personalization.addForm.noCategory")}</option>
                {Object.entries(memoryCategories).map(([val, { label }]) => (
                  <option key={val} value={val} className="bg-popover text-popover-foreground">
                    {label}
                  </option>
                ))}
              </select>

              {activeStoreTab === "memories" && (
                <div className="relative flex items-center">
                  <LuTag className="h-3 w-3 text-muted-foreground absolute left-2.5 pointer-events-none" />
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder={t("personalization.addForm.labelPlaceholder")}
                    maxLength={40}
                    className="h-8 pl-7 pr-2.5 w-36 rounded-xl bg-card dark:bg-black/40 border border-input dark:border-white/10 text-xs text-foreground outline-none"
                  />
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t("personalization.addForm.priorityLabel")}</span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={newImportance}
                  onChange={(e) => setNewImportance(parseInt(e.target.value) || 5)}
                  className="w-20 accent-primary cursor-pointer"
                />
                <span className="text-[11px] font-mono font-semibold text-foreground w-6 text-center">
                  {newImportance}
                </span>
              </div>

              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsAddOpen(false)}
                  className="h-8 rounded-xl text-xs"
                >
                  {t("personalization.actions.cancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!newContent.trim() || isSubmittingNew}
                  className="h-8 rounded-xl text-xs"
                >
                  {isSubmittingNew ? t("personalization.actions.saving") : t("personalization.actions.save")}
                </Button>
              </div>
            </div>
          </form>
        )}

        {/* Search & Category Filter Pills */}
        <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between">
          <div className="relative flex-1">
            <LuSearch className="h-3.5 w-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                activeStoreTab === "memories"
                  ? t("personalization.search.memoriesPlaceholder")
                  : t("personalization.search.notesPlaceholder")
              }
              className="h-9 pl-8 pr-8 rounded-xl bg-card dark:bg-white/[0.02] border-border dark:border-white/10 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <LuX className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {activeStoreTab === "memories" && (
            <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 no-scrollbar">
              <button
                type="button"
                onClick={() => setSelectedCategory("all")}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded-lg font-medium whitespace-nowrap transition-colors border",
                  selectedCategory === "all"
                    ? "bg-foreground text-background border-foreground"
                    : "bg-card dark:bg-white/[0.02] text-muted-foreground border-border dark:border-white/10 hover:text-foreground"
                )}
              >
                {t("personalization.search.allCategory", { count: categoryCounts.all })}
              </button>
              {Object.entries(memoryCategories).map(([key, meta]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedCategory(key)}
                  className={cn(
                    "text-[11px] px-2.5 py-1 rounded-lg font-medium whitespace-nowrap transition-colors border flex items-center gap-1.5",
                    selectedCategory === key
                      ? "bg-foreground text-background border-foreground"
                      : "bg-card dark:bg-white/[0.02] text-muted-foreground border-border dark:border-white/10 hover:text-foreground"
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                  <span>{meta.label}</span>
                  {categoryCounts[key] > 0 && (
                    <span className="opacity-70">{categoryCounts[key]}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* List Content */}
        <div>
          {(activeStoreTab === "memories" ? memoriesLoading : notesLoading) ? (
            <div className="flex flex-col gap-2.5">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 rounded-xl w-full" />
              ))}
            </div>
          ) : activeStoreTab === "memories" ? (
            filteredMemories.length === 0 ? (
              <div className="p-8 text-center rounded-2xl border border-dashed border-border dark:border-white/10 bg-muted/10 dark:bg-white/[0.01] space-y-2">
                <LuBrain className="h-6 w-6 text-muted-foreground/60 mx-auto" />
                <p className="text-xs font-medium text-foreground">
                  {memories.length === 0
                    ? t("personalization.emptyMemories.noneTitle")
                    : t("personalization.emptyMemories.filteredTitle")}
                </p>
                <p className="text-[11px] text-muted-foreground max-w-md mx-auto">
                  {memories.length === 0
                    ? t("personalization.emptyMemories.noneDescription")
                    : t("personalization.emptyMemories.filteredDescription")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filteredMemories.map((memory) => {
                  const priorityBadge = getImportanceLabel(memory.importance_score, t);
                  const createdStr = formatRelativeDate(memory.created_at, dateLocale);
                  const recalledStr = formatRelativeDate(memory.last_accessed_at, dateLocale);

                  return (
                    <div key={memory.uuid}>
                      {editingId === memory.uuid ? (
                        <div className="p-4 rounded-xl border border-primary/40 dark:border-zinc-500/40 bg-muted/40 dark:bg-black/40 flex flex-col gap-3">
                          <Input
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            placeholder={t("personalization.editForm.memoryPlaceholder")}
                            className="rounded-xl bg-card dark:bg-black/30 border-input dark:border-white/10 text-xs"
                          />
                          <div className="flex items-center gap-2 flex-wrap">
                            <select
                              value={editCategory}
                              onChange={(e) => setEditCategory(e.target.value)}
                              className="h-8 px-2 rounded-xl bg-card dark:bg-black/40 border border-input dark:border-white/10 text-xs text-foreground outline-none"
                            >
                              <option value="">{t("personalization.addForm.noCategory")}</option>
                              {Object.entries(memoryCategories).map(([val, { label }]) => (
                                <option key={val} value={val} className="bg-popover text-popover-foreground">
                                  {label}
                                </option>
                              ))}
                            </select>

                            <input
                              type="text"
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              placeholder={t("personalization.editForm.labelPlaceholder")}
                              className="h-8 px-2.5 w-36 rounded-xl bg-card dark:bg-black/40 border border-input dark:border-white/10 text-xs text-foreground outline-none"
                            />

                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {t("personalization.editForm.priorityLabel")}
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={10}
                              value={editImportance}
                              onChange={(e) =>
                                setEditImportance(
                                  Math.max(1, Math.min(10, parseInt(e.target.value) || 5))
                                )
                              }
                              className="w-14 h-8 px-2 rounded-xl bg-card dark:bg-black/40 border border-input dark:border-white/10 text-xs text-foreground text-center outline-none"
                            />

                            <div className="flex items-center gap-1 ml-auto">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={saveEdit}
                                className="h-8 w-8 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 rounded-lg"
                                title={t("personalization.actions.save")}
                              >
                                <LuCheck className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={cancelEdit}
                                className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted dark:hover:bg-white/10 rounded-lg"
                                title={t("personalization.actions.cancel")}
                              >
                                <LuX className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="group flex items-start justify-between p-3.5 rounded-xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] hover:bg-muted/40 dark:hover:bg-white/[0.04] transition-all shadow-sm dark:shadow-none">
                          <div className="flex-1 mr-3 min-w-0">
                            <p className="text-xs sm:text-sm text-foreground break-words leading-relaxed">
                              {memory.content}
                            </p>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              {memory.category && memoryCategories[memory.category] && (
                                <span
                                  className={cn(
                                    "text-[10px] px-2 py-0.5 rounded-full border font-medium",
                                    memoryCategories[memory.category].color
                                  )}
                                >
                                  {memoryCategories[memory.category].label}
                                </span>
                              )}

                              {memory.label && (
                                <span className="text-[10px] px-2 py-0.5 rounded-md bg-muted dark:bg-white/5 text-muted-foreground border border-border/60 dark:border-white/10 font-mono">
                                  #{memory.label}
                                </span>
                              )}

                              <span
                                className={cn(
                                  "text-[10px] px-2 py-0.5 rounded-full border font-medium",
                                  priorityBadge.className
                                )}
                                title={t("personalization.item.importanceTitle", { score: memory.importance_score })}
                              >
                                {priorityBadge.text} ({memory.importance_score}/10)
                              </span>

                              {createdStr && (
                                <span className="text-[11px] text-muted-foreground">
                                  {t("personalization.item.addedDate", { date: createdStr })}
                                </span>
                              )}

                              {recalledStr && (
                                <span className="text-[11px] text-emerald-600 dark:text-emerald-400/90 flex items-center gap-1">
                                  <LuClock className="h-3 w-3" />
                                  <span>{t("personalization.item.recalledDate", { date: recalledStr })}</span>
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditMemory(memory)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted dark:hover:bg-white/10 transition-colors"
                              title={t("personalization.actions.edit")}
                            >
                              <LuPencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteItem(memory.uuid)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-muted dark:hover:bg-white/10 transition-colors"
                              title={t("personalization.actions.delete")}
                            >
                              <LuTrash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : filteredNotes.length === 0 ? (
            <div className="p-8 text-center rounded-2xl border border-dashed border-border dark:border-white/10 bg-muted/10 dark:bg-white/[0.01] space-y-2">
              <LuFileText className="h-6 w-6 text-muted-foreground/60 mx-auto" />
              <p className="text-xs font-medium text-foreground">
                {t("personalization.emptyNotes.title")}
              </p>
              <p className="text-[11px] text-muted-foreground max-w-md mx-auto">
                {t("personalization.emptyNotes.description")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredNotes.map((note) => {
                const priorityBadge = getImportanceLabel(note.importance_score, t);
                const createdStr = formatRelativeDate(note.created_at, dateLocale);

                return (
                  <div key={note.uuid}>
                    {editingId === note.uuid ? (
                      <div className="p-4 rounded-xl border border-primary/40 dark:border-zinc-500/40 bg-muted/40 dark:bg-black/40 flex flex-col gap-3">
                        <Input
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          placeholder={t("personalization.editForm.notePlaceholder")}
                          className="rounded-xl bg-card dark:bg-black/30 border-input dark:border-white/10 text-xs"
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {t("personalization.editForm.priorityLabel")}
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={editImportance}
                            onChange={(e) =>
                              setEditImportance(
                                Math.max(1, Math.min(10, parseInt(e.target.value) || 3))
                              )
                            }
                            className="w-14 h-8 px-2 rounded-xl bg-card dark:bg-black/40 border border-input dark:border-white/10 text-xs text-foreground text-center outline-none"
                          />
                          <div className="flex items-center gap-1 ml-auto">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={saveEdit}
                              className="h-8 w-8 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 rounded-lg"
                              title={t("personalization.actions.save")}
                            >
                              <LuCheck className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={cancelEdit}
                              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted dark:hover:bg-white/10 rounded-lg"
                              title={t("personalization.actions.cancel")}
                            >
                              <LuX className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between p-3.5 rounded-xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] hover:bg-muted/40 dark:hover:bg-white/[0.04] transition-all shadow-sm dark:shadow-none">
                        <div className="flex-1 mr-3 min-w-0">
                          <p className="text-xs sm:text-sm text-foreground break-words leading-relaxed">
                            {note.content}
                          </p>
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            {note.category && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20">
                                {note.category}
                              </span>
                            )}
                            <span
                              className={cn(
                                "text-[10px] px-2 py-0.5 rounded-full border font-medium",
                                priorityBadge.className
                              )}
                            >
                              {priorityBadge.text} ({note.importance_score}/10)
                            </span>
                            {createdStr && (
                              <span className="text-[11px] text-muted-foreground">
                                {t("personalization.item.addedDate", { date: createdStr })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => startEditMemory(note)}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted dark:hover:bg-white/10 transition-colors"
                            title={t("personalization.actions.edit")}
                          >
                            <LuPencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteItem(note.uuid)}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-muted dark:hover:bg-white/10 transition-colors"
                            title={t("personalization.actions.delete")}
                          >
                            <LuTrash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Delete All Confirmation Dialog */}
      <Dialog open={isDeleteAllDialogOpen} onOpenChange={setIsDeleteAllDialogOpen}>
        <DialogContent className="max-w-sm bg-card dark:bg-[#0c0c14] p-5 rounded-2xl shadow-xl border border-border dark:border-white/10 text-foreground">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">{t("personalization.deleteAllDialog.title")}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-xs text-muted-foreground py-2">
            {t("personalization.deleteAllDialog.description", { count: memories.length })}
          </DialogDescription>
          <DialogFooter className="flex gap-2 justify-end pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsDeleteAllDialogOpen(false)}
              className="rounded-xl border-border dark:border-white/10 hover:bg-muted dark:hover:bg-white/5"
            >
              {t("personalization.actions.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDeleteAll} className="rounded-xl">
              {t("personalization.deleteAllDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
