"use client";

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import CloudAgentSelector from "@/components/chat/cloud-agent-selector";
import ImageLightbox from "@/components/image-lightbox";
import type { ImageData } from "@/stores/chat";
import {
    LuCpu,
    LuBox,
    LuPaperclip,
    LuFileText,
    LuBrain,
    LuChevronDown,
    LuChevronUp,
    LuChevronRight,
    LuCheck,
    LuArrowUp,
    LuMic,
    LuX,
    LuSearch,
    LuSquare,
    LuLoader as LuLoader2,
    LuGauge,
    LuInfo,
} from "react-icons/lu";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubTrigger,
    DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn, formatModelIdentifier } from "@/lib/utils";
import useModelStore from "@/stores/search-models";
import { DEFAULT_PLATFORM_MODELS } from "@/lib/default-models";
import {
    ACTIVE_EFFORT_TIERS,
    extractModelKey,
    getModelReasoningSpec,
    resolveModelReasoningTier,
    type ModelReasoningSpec,
    type ReasoningMode,
    type ReasoningTier,
} from "@/lib/reasoning";
import useWorkspacesStore from "@/stores/workspaces";
import { toaster } from "@/components/ui/toaster";

interface ModelWithType {
    name?: string;
    model?: string;
    tag?: string;
    type?: string;
    model_type?: string;
    is_reasoning?: boolean;
    reasoning_mode?: ReasoningMode | string;
    reasoning_tiers?: readonly (ReasoningTier | string)[];
    default_reasoning_effort?: ReasoningTier | string;
    supports_vision?: boolean;
    author?: string;
}

interface PromptInputProps {
    onSend: (message: string, files?: File[]) => void;
    onCancel?: () => void | Promise<void>;
    loading?: boolean;
    disabled?: boolean;
    placeholder?: string;
    mobilePlaceholder?: string;
    maxLength?: number;
    style?: React.CSSProperties;
    className?: string;
    compact?: boolean;
    currentModel: string;
    initialValue?: string;
    recentModels?: (string | ModelWithType)[];
    onSelectModel?: (model: string) => void;
    modelType?: "text" | "image";
    reasoningLevel?: ReasoningTier;
    reasoningLevelByModel?: Record<string, ReasoningTier>;
    setReasoningLevel?: (value: ReasoningTier) => void;
    showReasoningOptions?: boolean;
    reasoningMode?: ReasoningMode;
    reasoningTiers?: ReasoningTier[];
    defaultReasoningEffort?: ReasoningTier;
}

const PromptInput: React.FC<PromptInputProps> = ({
    onSend,
    onCancel,
    loading = false,
    disabled = false,
    maxLength = 4000,
    style,
    className,
    compact = false,
    currentModel,
    placeholder,
    mobilePlaceholder,
    initialValue,
    recentModels = [],
    onSelectModel,
    modelType = "text",
    reasoningLevel = "medium",
    reasoningLevelByModel,
    setReasoningLevel,
    showReasoningOptions = false,
    reasoningMode,
    reasoningTiers,
    defaultReasoningEffort,
}) => {
    const { t, i18n } = useTranslation("chat");
    const [message, setMessage] = useState(initialValue || "");
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(typeof window !== "undefined" && window.innerWidth < 640);
        };
        checkMobile();
        window.addEventListener("resize", checkMobile, { passive: true });
        return () => window.removeEventListener("resize", checkMobile);
    }, []);

    const effectivePlaceholder = isMobile && mobilePlaceholder ? mobilePlaceholder : (placeholder ?? t("composer.defaultPlaceholder"));

    useEffect(() => {
        if (initialValue !== undefined) {
            setMessage(initialValue);
            if (initialValue && textareaRef.current) {
                textareaRef.current.focus();
                const len = initialValue.length;
                textareaRef.current.setSelectionRange(len, len);
            }
        }
    }, [initialValue]);
    const [isListening, setIsListening] = useState(false);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [modelSearchQuery, setModelSearchQuery] = useState("");

    const wrapperRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const recognitionRef = useRef<any>(null);
    const dragCounterRef = useRef(0);
    const hasLoaded = useRef(false);

    const { models: searchResults, isLoading: isSearchLoading, fetchFirstPage } = useModelStore();

    // Auto-fetch popular models on mount
    useEffect(() => {
        if (!hasLoaded.current) {
            hasLoaded.current = true;
            void fetchFirstPage();
        }
    }, [fetchFirstPage]);

    // Reset search query when dropdown closes
    useEffect(() => {
        if (!modelDropdownOpen) {
            setModelSearchQuery("");
        }
    }, [modelDropdownOpen]);

    const handleModelSelect = useCallback((model: string, level?: ReasoningTier) => {
        if (onSelectModel) {
            onSelectModel(model);
        }
        if (level && setReasoningLevel) {
            setReasoningLevel(level);
        }
        setModelDropdownOpen(false);
    }, [onSelectModel, setReasoningLevel]);

    const [composerLightboxIndex, setComposerLightboxIndex] = useState<number | null>(null);

    // File preview URLs for image thumbnails
    const filePreviews = useMemo(() => {
        return uploadedFiles.map((file) => {
            const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
            let previewUrl: string | null = null;
            if (isImage) {
                try {
                    previewUrl = URL.createObjectURL(file);
                } catch {
                    previewUrl = null;
                }
            }
            return { file, isImage, previewUrl };
        });
    }, [uploadedFiles]);

    // Revoke object URLs on cleanup
    useEffect(() => {
        return () => {
            filePreviews.forEach((item) => {
                if (item.previewUrl) {
                    URL.revokeObjectURL(item.previewUrl);
                }
            });
        };
    }, [filePreviews]);

    const composerLightboxImages = useMemo<ImageData[]>(
        () =>
            filePreviews.flatMap(({ file, isImage, previewUrl }, index) =>
                isImage && previewUrl
                    ? [{
                        uuid: `${file.name}-${index}`,
                        image_url: previewUrl,
                        prompt: file.name,
                        negative_prompt: "",
                        width: 0,
                        height: 0,
                        seed: null,
                        created_at: "",
                    }]
                    : []
            ),
        [filePreviews]
    );

    // Update message when initialValue changes
    useEffect(() => {
        if (initialValue) {
            setMessage(initialValue);
        }
    }, [initialValue]);

    useEffect(() => {
        setUploadedFiles([]);
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    }, [modelType]);

    // Speech Recognition setup
    useEffect(() => {
        if (typeof window !== "undefined" && "webkitSpeechRecognition" in window) {
            const SpeechRecognition = (window as any).webkitSpeechRecognition;
            recognitionRef.current = new SpeechRecognition();
            recognitionRef.current.continuous = true;
            recognitionRef.current.interimResults = true;
            recognitionRef.current.lang = i18n.resolvedLanguage || "en-US";

            recognitionRef.current.onstart = () => {
                setIsListening(true);
            };

            recognitionRef.current.onresult = (event: any) => {
                let transcript = "";
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        transcript += event.results[i][0].transcript;
                    }
                }
                if (transcript) {
                    setMessage((prev) => prev + transcript);
                }
            };

            recognitionRef.current.onend = () => {
                setIsListening(false);
            };

            recognitionRef.current.onerror = () => {
                setIsListening(false);
            };
        }

        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
            }
        };
    }, []);

    useEffect(() => {
        if (recognitionRef.current) {
            recognitionRef.current.lang = i18n.resolvedLanguage || "en-US";
        }
    }, [i18n.resolvedLanguage]);

    const handleSend = useCallback(() => {
        if (!message.trim() && uploadedFiles.length === 0) return;
        if (loading || disabled) return;

        // Keep focus inside the composer when sending via Enter or clicking the Send button
        // (the Send button swaps to Stop when loading becomes true).
        const hadComposerFocus =
            typeof document !== "undefined" &&
            Boolean(wrapperRef.current?.contains(document.activeElement));

        onSend(message.trim(), uploadedFiles.length ? uploadedFiles : undefined);
        setMessage("");
        setUploadedFiles([]);
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }

        // Reset textarea height and overflow
        if (textareaRef.current) {
            textareaRef.current.style.height = "";
            textareaRef.current.style.overflowY = "hidden";
            if (hadComposerFocus && document.activeElement !== textareaRef.current) {
                textareaRef.current.focus({ preventScroll: true });
            }
        }
    }, [message, uploadedFiles, onSend, loading, disabled]);

    const adjustTextareaHeight = useCallback(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const maxHeight = compact ? 200 : 220;

        if (!message) {
            textarea.style.height = "";
            textarea.style.overflowY = "hidden";
            return;
        }

        textarea.style.height = "auto";
        const scrollHeight = textarea.scrollHeight;

        if (scrollHeight > maxHeight) {
            textarea.style.height = `${maxHeight}px`;
            textarea.style.overflowY = "auto";
        } else {
            textarea.style.height = `${scrollHeight}px`;
            textarea.style.overflowY = "hidden";
        }
    }, [message, compact]);

    useEffect(() => {
        adjustTextareaHeight();
    }, [adjustTextareaHeight]);

    useEffect(() => {
        const handleResize = () => {
            adjustTextareaHeight();
        };
        window.addEventListener("resize", handleResize, { passive: true });
        return () => window.removeEventListener("resize", handleResize);
    }, [adjustTextareaHeight]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.ctrlKey || e.metaKey) {
            return;
        }

        if (e.key === "Enter") {
            if (e.shiftKey) {
                return;
            } else {
                e.preventDefault();
                handleSend();
            }
        }
    };

    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        if (value.length <= maxLength) {
            setMessage(value);
        }

        const textarea = e.target;
        const maxHeight = compact ? 200 : 220;

        if (!value) {
            textarea.style.height = "";
            textarea.style.overflowY = "hidden";
            return;
        }

        textarea.style.height = "auto";
        const scrollHeight = textarea.scrollHeight;

        if (scrollHeight > maxHeight) {
            textarea.style.height = `${maxHeight}px`;
            textarea.style.overflowY = "auto";
        } else {
            textarea.style.height = `${scrollHeight}px`;
            textarea.style.overflowY = "hidden";
        }
    };

    // Unified file validator and processor
    const processFiles = useCallback((filesToProcess: File[]) => {
        if (filesToProcess.length === 0) return;
        const validFiles: File[] = [];
        const allowedExtensions = new Set([
            // Documents & data
            "pdf", "txt", "md", "csv", "json", "tsv", "yaml", "yml", "toml", "xml", "html", "css",
            // Images
            "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg",
            // Code & configs
            "js", "ts", "jsx", "tsx", "py", "sh", "bash", "sql", "rs", "go", "c", "cpp", "h", "hpp", "java", "kt", "rb", "php", "env", "diff", "patch"
        ]);
        const maxFileSizeBytes = 10 * 1024 * 1024; // 10MB limit

        for (const file of filesToProcess) {
            const isImage = file.type.startsWith("image/");
            const extension = file.name.split(".").pop()?.toLowerCase() || "";
            if (!isImage && !allowedExtensions.has(extension)) {
                toaster.create({
                    title: t("composer.unsupportedFileTitle"),
                    description: t("composer.unsupportedFileDescription", { name: file.name }),
                    type: "error",
                });
                continue;
            }
            if (file.size > maxFileSizeBytes) {
                toaster.create({
                    title: t("composer.fileTooLargeTitle"),
                    description: t("composer.fileTooLargeDescription", { name: file.name }),
                    type: "error",
                });
                continue;
            }
            validFiles.push(file);
        }

        if (validFiles.length > 0) {
            setUploadedFiles((prev) => {
                const remainingSlots = 5 - prev.length;
                if (remainingSlots <= 0) {
                    toaster.create({
                        title: t("composer.fileLimitTitle"),
                        description: t("composer.fileLimitDescription"),
                        type: "warning",
                    });
                    return prev;
                }
                return [...prev, ...validFiles.slice(0, remainingSlots)];
            });
        }
    }, [t]);

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0) {
            processFiles(Array.from(files));
        }
        e.target.value = "";
    };

    // Clipboard Paste support (e.g. screenshot or document)
    const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files: File[] = [];
        if (e.clipboardData.items && e.clipboardData.items.length > 0) {
            for (let i = 0; i < e.clipboardData.items.length; i++) {
                const item = e.clipboardData.items[i];
                if (item.kind === "file") {
                    const file = item.getAsFile();
                    if (file) {
                        const isImage = file.type.startsWith("image/");
                        if (isImage && (!file.name || file.name === "image.png" || file.name === "blob")) {
                            const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
                            const timestamp = `${Date.now()}`;
                            const namedFile = new File([file], `screenshot_${timestamp}.${ext}`, { type: file.type });
                            files.push(namedFile);
                        } else {
                            files.push(file);
                        }
                    }
                }
            }
        } else if (e.clipboardData.files && e.clipboardData.files.length > 0) {
            files.push(...Array.from(e.clipboardData.files));
        }

        if (files.length > 0) {
            e.preventDefault();
            processFiles(files);
        }
    }, [processFiles]);

    // Drag and Drop handlers
    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current += 1;
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
            setIsDragging(false);
            dragCounterRef.current = 0;
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        dragCounterRef.current = 0;
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            processFiles(Array.from(e.dataTransfer.files));
        }
    };

    const removeFile = (index: number) => {
        setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const handleMicrophoneClick = () => {
        if (!recognitionRef.current) {
            toaster.create({
                title: t("composer.voiceUnavailableTitle"),
                description: t("composer.voiceUnavailableDescription"),
                type: "info",
            });
            return;
        }

        try {
            if (isListening) {
                setIsListening(false);
                recognitionRef.current.stop();
            } else {
                recognitionRef.current.start();
            }
        } catch {
            setIsListening(false);
        }
    };

    const getModelName = (model: string | ModelWithType | any): string => {
        if (typeof model === "string") return formatModelIdentifier(model);
        if (model.name) return formatModelIdentifier(model.name);
        if (model.model) return formatModelIdentifier(model.model, model.tag);
        return "";
    };

    const getModelAuthor = (model: string | ModelWithType | any): string => {
        if (typeof model === "string") return "";
        return model.author || "";
    };

    const acceptedFileTypes = ".pdf,.txt,.md,.csv,.json,.yaml,.yml,.toml,.xml,.py,.js,.ts,.tsx,.jsx,.sh,.sql,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,image/*,application/pdf,text/*";

    const hasContent = Boolean(message.trim() || uploadedFiles.length > 0);
    const isSendDisabled = !hasContent || loading || disabled;

    const allAvailableModels = useMemo(() => {
        type AvailableModelItem = {
            name: string;
            displayName: string;
            isReasoning: boolean;
            reasoningSpec: ModelReasoningSpec;
            supportsVision?: boolean;
            isByok?: boolean;
            isByos?: boolean;
            providerName?: string;
            isFreeTier?: boolean;
            isNew?: boolean;
            isNotice?: boolean;
            author?: string;
            variantMap?: Partial<Record<ReasoningTier, string>>;
        };
        const list: AvailableModelItem[] = [];
        const seen = new Set<string>();
        const seenDisplayNames = new Set<string>();

        const normalizeModelName = (rawName: string): string => {
            if (rawName === "deepseek-v4.1-flash" || rawName === "deepseek/deepseek-v4.1-flash") {
                return "deepseek-v4.1-flash-1017";
            }
            return rawName;
        };

        const cleanDisplayNameStr = (name: string, rawDisplay?: string): string => {
            let clean = rawDisplay || (name.includes("/") ? name.split("/").pop() || name : name);
            clean = clean.replace(/\s*\(1017\)/g, "").replace(/\s*\(BYOS\)\s*$/i, "").trim();
            if (name === "deepseek-v4.1-flash-1017" || name === "deepseek-v4.1-flash") {
                return "DeepSeek V4.1 Flash";
            }
            return clean;
        };

        const extractInlineTier = (name: string, display: string): ReasoningTier | null => {
            const dispMatch = display.match(/\s+\((minimal|low|medium|high|xhigh|max)\)$/i);
            if (dispMatch) return dispMatch[1].toLowerCase() as ReasoningTier;
            const slugMatch = name.match(/-byos-antigravity-.*-(minimal|low|medium|high|xhigh|max)$/i);
            if (slugMatch) return slugMatch[1].toLowerCase() as ReasoningTier;
            return null;
        };

        const stripInlineTierDisplay = (display: string): string =>
            display.replace(/\s+\((minimal|low|medium|high|xhigh|max)\)$/i, "").trim();

        const inferScope = (m: { name: string; providerName?: string }): string => {
            if (["anthropic_sub", "openai_sub", "antigravity_sub"].includes(m.providerName || "")) return m.providerName!;
            if (/-byos-claude-/i.test(m.name)) return "anthropic_sub";
            if (/-byos-(gpt|codex)-/i.test(m.name)) return "openai_sub";
            if (/-byos-antigravity-/i.test(m.name)) return "antigravity_sub";
            return "neuron";
        };

        const add = (item: any) => {
            if (!item) return;
            const rawName = getModelName(item);
            if (!rawName) return;
            const name = normalizeModelName(rawName);
            const fallbackEntry = DEFAULT_PLATFORM_MODELS.find(
                (d) => extractModelKey(d.name) === extractModelKey(name)
            );

            const rawDisplayName = typeof item === "object" ? item.display_name : undefined;
            const cleanDisplayName = cleanDisplayNameStr(name, rawDisplayName);
            const itemProvider = typeof item === "object" ? item.provider_name : undefined;
            const providerScope = ["anthropic_sub", "openai_sub", "antigravity_sub"].includes(itemProvider || "")
                ? itemProvider
                : /-byos-claude-/i.test(name) ? "anthropic_sub"
                : /-byos-(gpt|codex)-/i.test(name) ? "openai_sub"
                : /-byos-antigravity-/i.test(name) ? "antigravity_sub"
                : "neuron";
            const displayKey = `${providerScope}::${cleanDisplayName.toLowerCase()}`;

            const isAntigravityNoTier =
                (typeof item === "object" && item.provider_name === "antigravity_sub") ||
                /-byos-antigravity-/i.test(name);
            const inlineEffort = extractInlineTier(name, cleanDisplayName) !== null;
            const hasExplicitIsReasoning = typeof item === "object" && typeof item.is_reasoning === "boolean";
            const resolvedIsReasoning = inlineEffort || isAntigravityNoTier
                ? false
                : hasExplicitIsReasoning
                  ? Boolean(item.is_reasoning)
                  : typeof fallbackEntry?.is_reasoning === "boolean"
                    ? Boolean(fallbackEntry.is_reasoning)
                    : Boolean(
                          /reason|thinking|r1|flash|claude|gemini|gpt/i.test(name) ||
                              /reason|thinking|r1/i.test(cleanDisplayName)
                      );

            const candidateSpec = getModelReasoningSpec(
                inlineEffort || isAntigravityNoTier
                    ? {
                          name,
                          is_reasoning: false,
                          reasoning_mode: "none",
                          reasoning_tiers: [],
                          default_reasoning_effort: "none",
                      }
                    : typeof item === "object"
                      ? {
                            ...item,
                            name,
                            is_reasoning: resolvedIsReasoning,
                        }
                      : {
                            name,
                            is_reasoning: resolvedIsReasoning,
                        },
                DEFAULT_PLATFORM_MODELS
            );

            if (seen.has(name) || seenDisplayNames.has(displayKey)) {
                const existing = list.find((m) => m.name === name || `${inferScope(m)}::${m.displayName.toLowerCase()}` === displayKey);
                if (existing && typeof item === "object") {
                    if (cleanDisplayName && (existing.displayName === existing.name || existing.displayName.includes("1017"))) {
                        existing.displayName = cleanDisplayName;
                    }
                    if (item.is_byok !== undefined) {
                        existing.isByok = Boolean(item.is_byok || item.workspace_id || item.workspace || name.startsWith("ws-"));
                    }
                    if (item.is_byos !== undefined || item.provider_name) {
                        existing.isByos = Boolean(
                            item.is_byos ||
                            item.provider_name === "anthropic_sub" ||
                            item.provider_name === "openai_sub" ||
                            item.provider_name === "antigravity_sub"
                        );
                        if (item.provider_name) existing.providerName = item.provider_name;
                    }
                    if (typeof item.is_free_tier === "boolean") {
                        existing.isFreeTier = Boolean(item.is_free_tier);
                    }
                    if (candidateSpec.hasExplicitTiers && !existing.reasoningSpec.hasExplicitTiers) {
                        existing.reasoningSpec = candidateSpec;
                        existing.isReasoning = candidateSpec.isReasoning;
                    }
                }
                return;
            }
            seen.add(name);
            seenDisplayNames.add(displayKey);

            const supportsVision = typeof item === "object"
                ? Boolean(item.supports_vision || item.supportsVision || fallbackEntry?.supports_vision || /gpt-4|gpt-5|gpt-6|claude|gemini|grok|vision|vl|multimodal/i.test(name) || /gpt-4|gpt-5|gpt-6|claude|gemini|grok|vision/i.test(cleanDisplayName))
                : Boolean(fallbackEntry?.supports_vision || /gpt-4|gpt-5|gpt-6|claude|gemini|grok|vision|vl/i.test(name));

            const isByos = typeof item === "object"
                ? Boolean(
                      item.is_byos ||
                      item.provider_name === "anthropic_sub" ||
                      item.provider_name === "openai_sub" ||
                      item.provider_name === "antigravity_sub"
                  )
                : false;

            const isByok = !isByos && (
                typeof item === "object"
                    ? Boolean(item.is_byok || item.workspace_id || item.workspace || name.startsWith("ws-"))
                    : Boolean(name.startsWith("ws-"))
            );

            const isFreeTier = typeof item === "object" && typeof item.is_free_tier === "boolean"
                ? Boolean(item.is_free_tier)
                : Boolean(fallbackEntry?.is_free_tier);

            const isNew = typeof item === "object"
                ? Boolean(item.is_new || /new/i.test(item.tag || "") || (item.tags && item.tags.some((t: any) => /new/i.test(t.name || ""))))
                : false;

            const isNotice = typeof item === "object"
                ? Boolean(item.is_notice || /notice/i.test(item.tag || ""))
                : false;

            list.push({
                name,
                displayName: cleanDisplayName,
                isReasoning: candidateSpec.isReasoning,
                reasoningSpec: candidateSpec,
                supportsVision,
                isByok,
                isByos,
                providerName: typeof item === "object" ? item.provider_name : undefined,
                isFreeTier,
                isNew,
                isNotice,
                author: typeof item === "object" ? item.author : fallbackEntry?.author,
            });
        };

        const hasLiveByosResults = (searchResults || []).some(
            (m: any) =>
                m.is_byos ||
                ["anthropic_sub", "openai_sub", "antigravity_sub"].includes(m.provider_name || "")
        );
        (searchResults || []).forEach(add);
        (recentModels || []).forEach((rm: any) => {
            const rmName = getModelName(rm);
            const rmIsByos = Boolean(
                rm?.is_byos ||
                    ["anthropic_sub", "openai_sub", "antigravity_sub"].includes(rm?.provider_name || "") ||
                    rmName.includes("-byos-")
            );
            if (rmIsByos && hasLiveByosResults) {
                const stillExists = (searchResults || []).some((sm: any) => getModelName(sm) === rmName);
                if (!stillExists) return;
            }
            add(rm);
        });
        const normalizedCurrent = currentModel ? normalizeModelName(currentModel) : "";
        if (normalizedCurrent) {
            add({
                name: normalizedCurrent,
                display_name: cleanDisplayNameStr(normalizedCurrent),
                ...(typeof showReasoningOptions === "boolean" ? { is_reasoning: showReasoningOptions } : {}),
                ...(reasoningMode && reasoningMode !== "none" ? { reasoning_mode: reasoningMode } : {}),
                ...(reasoningTiers && reasoningTiers.length > 0 ? { reasoning_tiers: reasoningTiers } : {}),
                ...(defaultReasoningEffort ? { default_reasoning_effort: defaultReasoningEffort } : {}),
            });
        }
        if ((recentModels || []).length === 0 && (searchResults || []).length === 0) {
            DEFAULT_PLATFORM_MODELS.forEach(add);
        }

        // Filter models to only those belonging to the currently active Cloud Agent
        const activeProviderMatch = (() => {
            const currentObj = (searchResults || []).find((m: any) => m.name === normalizedCurrent);
            const p = currentObj?.provider_name;
            if (p === "anthropic_sub" || normalizedCurrent.includes("-byos-claude-")) return "anthropic_sub";
            if (p === "openai_sub" || normalizedCurrent.includes("-byos-gpt-") || normalizedCurrent.includes("-byos-codex-")) return "openai_sub";
            if (p === "antigravity_sub" || normalizedCurrent.includes("-byos-antigravity-")) return "antigravity_sub";
            return "neuron";
        })();

        const inferProvider = (m: AvailableModelItem): string => {
            if (m.providerName === "anthropic_sub" || m.name.includes("-byos-claude-")) return "anthropic_sub";
            if (m.providerName === "openai_sub" || m.name.includes("-byos-gpt-") || m.name.includes("-byos-codex-")) return "openai_sub";
            if (m.providerName === "antigravity_sub" || m.name.includes("-byos-antigravity-")) return "antigravity_sub";
            return m.isByos ? "byos_other" : "neuron";
        };

        const filtered = list.filter((m) => inferProvider(m) === activeProviderMatch);

        // Group models whose variants encode reasoning tiers inline (e.g. "Gemini 4 Hydrogen (Low/Medium/High/XHigh)")
        const grouped: AvailableModelItem[] = [];
        const variantGroups = new Map<string, { item: AvailableModelItem; variants: Partial<Record<ReasoningTier, string>> }>();

        for (const m of filtered) {
            const tier = extractInlineTier(m.name, m.displayName);
            if (!tier) {
                grouped.push(m);
                continue;
            }
            const baseDisplay = stripInlineTierDisplay(m.displayName);
            const groupKey = `${inferProvider(m)}::${baseDisplay.toLowerCase()}`;
            let entry = variantGroups.get(groupKey);
            if (!entry) {
                const clone: AvailableModelItem = {
                    ...m,
                    displayName: baseDisplay,
                    variantMap: { [tier]: m.name },
                };
                entry = { item: clone, variants: clone.variantMap! };
                variantGroups.set(groupKey, entry);
                grouped.push(clone);
            } else {
                entry.variants[tier] = m.name;
            }
        }

        for (const entry of variantGroups.values()) {
            const orderedTiers = ACTIVE_EFFORT_TIERS.filter((t) => Boolean(entry.variants[t]));
            const defaultTier: ReasoningTier = entry.variants.medium
                ? "medium"
                : orderedTiers[0] || "medium";
            entry.item.name = entry.variants[defaultTier] || entry.item.name;
            entry.item.isReasoning = true;
            entry.item.reasoningSpec = {
                isReasoning: true,
                mode: orderedTiers.length > 1 ? "effort" : "fixed",
                tiers: orderedTiers,
                defaultTier,
                hasExplicitTiers: true,
            };
        }

        // Surface Free-tier models first
        grouped.sort(
            (a, b) => Number(Boolean(b.isFreeTier)) - Number(Boolean(a.isFreeTier))
        );
        return grouped;
    }, [currentModel, defaultReasoningEffort, reasoningMode, reasoningTiers, recentModels, searchResults, showReasoningOptions]);

    const findMatchingModelItem = useCallback(
        (targetName: string) => {
            if (!targetName) return undefined;
            const normalized = targetName === "deepseek-v4.1-flash" ? "deepseek-v4.1-flash-1017" : targetName;
            const targetKey = extractModelKey(normalized);
            return allAvailableModels.find(
                (m) =>
                    m.name === normalized ||
                    m.name === targetName ||
                    extractModelKey(m.name) === targetKey ||
                    Object.values(m.variantMap || {}).some((v) => v === normalized || v === targetName)
            );
        },
        [allAvailableModels]
    );

    const findVariantTierForModel = useCallback(
        (item: (typeof allAvailableModels)[number] | undefined, targetName: string): ReasoningTier | undefined => {
            if (!item?.variantMap || !targetName) return undefined;
            const hit = (Object.entries(item.variantMap) as Array<[ReasoningTier, string | undefined]>).find(
                ([, val]) => val === targetName
            );
            return hit?.[0];
        },
        []
    );

    const activeReasoningSpec = useMemo(() => {
        const matched = findMatchingModelItem(currentModel);
        if (matched && (matched.variantMap || !matched.reasoningSpec.isReasoning)) {
            return matched.reasoningSpec;
        }
        if (showReasoningOptions && reasoningTiers && reasoningTiers.length > 0) {
            return getModelReasoningSpec(
                {
                    name: currentModel,
                    is_reasoning: true,
                    reasoning_mode: reasoningMode,
                    reasoning_tiers: reasoningTiers,
                    default_reasoning_effort: defaultReasoningEffort,
                },
                DEFAULT_PLATFORM_MODELS
            );
        }
        if (matched) return matched.reasoningSpec;
        return getModelReasoningSpec(
            {
                name: currentModel,
                is_reasoning: showReasoningOptions,
                reasoning_mode: reasoningMode,
                reasoning_tiers: reasoningTiers,
                default_reasoning_effort: defaultReasoningEffort,
            },
            DEFAULT_PLATFORM_MODELS
        );
    }, [currentModel, defaultReasoningEffort, findMatchingModelItem, reasoningMode, reasoningTiers, showReasoningOptions]);

    const resolvedActiveTier = useMemo(() => {
        if (!activeReasoningSpec.isReasoning) return "none" as ReasoningTier;
        const matched = findMatchingModelItem(currentModel);
        const variantTier = findVariantTierForModel(matched, currentModel);
        if (variantTier) return variantTier;
        return resolveModelReasoningTier(activeReasoningSpec, reasoningLevel);
    }, [activeReasoningSpec, currentModel, findMatchingModelItem, findVariantTierForModel, reasoningLevel]);

    const currentReasoningLabel = useMemo(() => {
        if (!activeReasoningSpec.isReasoning) return "";
        return t(`composer.reasoning.${resolvedActiveTier}`, {
            defaultValue:
                resolvedActiveTier === "none" ? "Off" : resolvedActiveTier === "on" ? "On" : resolvedActiveTier,
        });
    }, [activeReasoningSpec.isReasoning, resolvedActiveTier, t]);

    const displayModelsList = useMemo(() => {
        if (!modelSearchQuery.trim()) return allAvailableModels;

        const q = modelSearchQuery.toLowerCase().trim();
        return allAvailableModels.filter((m) =>
            m.name.toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q) ||
            (m.author && m.author.toLowerCase().includes(q))
        );
    }, [allAvailableModels, modelSearchQuery]);

    const renderModelBadges = (item: { isFreeTier?: boolean; isByok?: boolean; isByos?: boolean }) => (
        <>
            {item.isFreeTier && (
                <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 leading-none shrink-0">
                    Included
                </span>
            )}
            {!item.isByos && item.isByok && (
                <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 leading-none shrink-0">
                    BYOK
                </span>
            )}
        </>
    );

    const currentModelDisplayName = useMemo(() => {
        if (!currentModel) return "";
        const normalized = currentModel === "deepseek-v4.1-flash" ? "deepseek-v4.1-flash-1017" : currentModel;
        const matched = findMatchingModelItem(normalized) || findMatchingModelItem(currentModel);
        if (matched?.displayName) return matched.displayName.replace(/\s*\(1017\)/g, "").replace(/\s*\(BYOS\)\s*$/i, "").trim();
        if (normalized === "deepseek-v4.1-flash-1017") return "DeepSeek V4.1 Flash";
        return currentModel.includes("/") ? currentModel.split("/").pop() || currentModel : currentModel;
    }, [currentModel, findMatchingModelItem]);

    return (
        <div ref={wrapperRef} style={style} className={cn("group/prompt-wrapper relative w-full transition-all duration-300", className)}>
            {/* Ambient color burst glow (renk patlaması) behind the prompt card */}
            <div
                aria-hidden="true"
                className={cn(
                    "pointer-events-none absolute -inset-1 sm:-inset-1.5 rounded-[26px] opacity-0 blur-xl sm:blur-2xl transition-all duration-500",
                    "bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-400",
                    "group-hover/prompt-wrapper:opacity-20 dark:group-hover/prompt-wrapper:opacity-30",
                    "group-focus-within/prompt-wrapper:opacity-45 dark:group-focus-within/prompt-wrapper:opacity-60",
                    "group-focus-within/prompt-wrapper:blur-2xl sm:group-focus-within/prompt-wrapper:blur-3xl"
                )}
            />

            {/* Main prompt input card container */}
            <div
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                className={cn(
                    "group/prompt relative z-10 w-full transition-all duration-200",
                    "rounded-2xl sm:rounded-[22px]",
                    "border border-black/[0.05] dark:border-white/[0.06]",
                    "bg-card dark:bg-[#0c0d14]/90 backdrop-blur-2xl",
                    "shadow-[0_4px_24px_-4px_rgba(0,0,0,0.04)] dark:shadow-[0_10px_35px_-8px_rgba(0,0,0,0.6)]",
                    "hover:border-black/[0.09] dark:hover:border-white/[0.10]",
                    "focus-within:border-indigo-500/40 dark:focus-within:border-indigo-400/50",
                    "focus-within:shadow-[0_0_35px_-5px_rgba(99,102,241,0.22),0_12px_40px_-10px_rgba(0,0,0,0.08)] dark:focus-within:shadow-[0_0_45px_-5px_rgba(99,102,241,0.3),0_16px_50px_-12px_rgba(0,0,0,0.85)]",
                    isDragging && "border-dashed border-primary/50 bg-primary/[0.02]",
                    compact ? "p-1.5" : "p-2 sm:p-2.5"
                )}
            >
                {/* Drag and Drop visual overlay */}
                {isDragging && (
                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl bg-background/90 dark:bg-[#0c0d14]/95 backdrop-blur-md border-2 border-dashed border-primary animate-in fade-in-0 duration-150 pointer-events-none">
                        <div className="p-3 rounded-full bg-primary/10 text-primary">
                            <LuPaperclip className="h-6 w-6 animate-bounce" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-semibold text-foreground">{t("composer.dropFilesTitle")}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {t("composer.dropFilesDescription")}
                            </p>
                        </div>
                    </div>
                )}

                {/* Textarea container */}
                <div className="flex w-full items-stretch px-2 sm:px-3 pt-1">
                    <textarea
                        ref={textareaRef}
                        value={message}
                        onChange={handleTextareaChange}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        placeholder={effectivePlaceholder}
                        disabled={disabled}
                        rows={1}
                        className={cn(
                            "w-full resize-none border-0 bg-transparent px-1.5 py-1.5 text-base text-foreground leading-relaxed",
                            "outline-none placeholder:text-muted-foreground/60 focus:ring-0",
                            "overflow-y-hidden placeholder:truncate",
                            "scrollbar-thin scrollbar-thumb-muted-foreground/20 hover:scrollbar-thumb-muted-foreground/40",
                            compact ? "min-h-[44px] max-h-[200px]" : "min-h-[48px] max-h-[240px]"
                        )}
                    />
                </div>

                {/* Uploaded File Previews (Dedicated thumbnail / badge row) */}
                {uploadedFiles.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 px-2.5 sm:px-3 pt-2 pb-1 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                        {filePreviews.map(({ file, isImage, previewUrl }, index) => {
                            const formattedSize = file.size > 1024 * 1024
                                ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
                                : `${Math.round(file.size / 1024)} KB`;

                            if (isImage && previewUrl) {
                                return (
                                    <div
                                        key={`${file.name}-${index}`}
                                        className="group relative rounded-xl border border-border/70 shadow-sm hover:border-border/90 transition-all"
                                    >
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const i = composerLightboxImages.findIndex((img) => img.uuid === `${file.name}-${index}`);
                                                if (i >= 0) setComposerLightboxIndex(i);
                                            }}
                                            aria-label={file.name}
                                            className="block cursor-zoom-in"
                                        >
                                            <div className="relative h-16 w-16 sm:h-20 sm:w-20 overflow-hidden rounded-xl bg-black/10">
                                                <img
                                                    src={previewUrl}
                                                    alt={file.name}
                                                    className="h-full w-full object-cover"
                                                />
                                            </div>
</button>
                                        <button
                                            type="button"
                                            onClick={() => removeFile(index)}
                                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-destructive transition-colors"
                                            title={t("composer.removeFile")}
                                        >
                                            <LuX className="h-3 w-3" />
                                        </button>
                                    </div>
                                );
                            }

                            return (
                                <div
                                    key={`${file.name}-${index}`}
                                    className="group relative flex items-center gap-2 rounded-xl border border-border/70 bg-muted/40 dark:bg-zinc-900/60 px-2.5 py-1.5 shadow-sm hover:border-border/90 hover:bg-muted/60 transition-all"
                                >
                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                                        <LuFileText className="h-4 w-4" />
                                    </div>
                                    <div className="flex flex-col min-w-0 pr-1">
                                        <span className="text-xs font-medium text-foreground truncate max-w-[120px] sm:max-w-[160px]">
                                            {file.name}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground">
                                            {formattedSize}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => removeFile(index)}
                                        className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors shrink-0 ml-1"
                                        title={t("composer.removeFile")}
                                    >
                                        <LuX className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                <ImageLightbox
                    open={composerLightboxIndex !== null}
                    onClose={() => setComposerLightboxIndex(null)}
                    images={composerLightboxImages}
                    initialIndex={composerLightboxIndex ?? 0}
                />

                {/* Bottom toolbar */}
                <div className="mt-1 flex min-w-0 items-center justify-between gap-1 sm:gap-1.5 px-1 sm:px-1.5 pt-1">
                    {/* Left Actions */}
                    {/* Left Actions: Attach File + Unified Model Selector */}
                    <div className="flex shrink-0 items-center gap-1 sm:gap-1.5 min-w-0">
                        {/* File Upload */}
                        <label
                            className={cn(
                                "relative flex items-center justify-center h-8 w-8 sm:h-8.5 sm:w-8.5 rounded-full cursor-pointer text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0",
                                uploadedFiles.length > 0 && "text-primary hover:text-primary hover:bg-primary/10"
                            )}
                            title={t("composer.attachFiles")}
                        >
                            <LuPaperclip className="h-4 w-4" />
                            {uploadedFiles.length > 0 && (
                                <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-1 text-[10px] font-semibold rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
                                    {uploadedFiles.length}
                                </span>
                            )}
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept={acceptedFileTypes}
                                className="hidden"
                                onChange={handleFileUpload}
                            />
                        </label>

                        {/* Harness / Cloud Agent Selector (active chat composer) */}
                        {!compact && (
                            <>
                                <CloudAgentSelector variant="composer" />
                                {currentModel && (
                                    <span className="h-3.5 w-px bg-border/70 shrink-0" aria-hidden="true" />
                                )}
                            </>
                        )}

                        {/* Unified Model & Reasoning Selector */}
                        {currentModel && (
                            <DropdownMenu open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        className={cn(
                                            "inline-flex h-8 sm:h-8.5 items-center gap-1.5 px-2 sm:px-2.5 rounded-lg text-xs sm:text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 dark:hover:bg-zinc-800/60 transition-colors cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-primary/40 min-w-0 group/trigger",
                                            modelDropdownOpen && "bg-muted/60 dark:bg-zinc-800/60 text-foreground"
                                        )}
                                        title={t("composer.modelTooltip", { model: currentModel, level: currentReasoningLabel || t("composer.reasoning.default") })}
                                    >
                                        <span className="font-normal text-muted-foreground group-hover/trigger:text-foreground truncate max-w-[160px] sm:max-w-[280px] md:max-w-[340px] transition-colors" title={currentModelDisplayName}>
                                            {currentModelDisplayName}
                                        </span>
                                        {activeReasoningSpec.isReasoning && currentReasoningLabel && (
                                            <span className="font-normal text-muted-foreground/75 group-hover/trigger:text-foreground/80 text-xs sm:text-sm shrink-0 transition-colors">
                                                {currentReasoningLabel}
                                            </span>
                                        )}
                                        <LuChevronUp
                                            className={cn(
                                                "h-3.5 w-3.5 text-muted-foreground/70 group-hover/trigger:text-foreground transition-all duration-200 shrink-0",
                                                modelDropdownOpen && "rotate-180 text-foreground"
                                            )}
                                        />
                                    </button>
                                </DropdownMenuTrigger>

                                <DropdownMenuContent
                                    side="top"
                                    align="start"
                                    sideOffset={8}
                                    collisionPadding={12}
                                    className="w-[calc(100vw-2rem)] sm:w-[420px] max-w-[440px] max-h-[min(480px,var(--radix-dropdown-menu-content-available-height,calc(100vh-2rem)))] flex flex-col rounded-2xl bg-popover border border-border text-popover-foreground p-1.5 shadow-xl outline-none overflow-hidden z-[1200]"
                                >
                                    <div className="shrink-0 px-3 pt-2 pb-1.5 text-xs font-medium text-muted-foreground select-none">
                                        {t("composer.modelLabel")}
                                    </div>

                                    {(allAvailableModels.length > 5 || Boolean(modelSearchQuery)) && (
                                        <div className="shrink-0 px-1.5 pb-1.5">
                                            <div className="relative">
                                                <LuSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
                                                <input
                                                    type="text"
                                                    placeholder={t("composer.searchModels")}
                                                    value={modelSearchQuery}
                                                    onChange={(e) => setModelSearchQuery(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        e.stopPropagation();
                                                        if (e.key === "Escape" && modelSearchQuery) {
                                                            e.preventDefault();
                                                            setModelSearchQuery("");
                                                        }
                                                    }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="w-full bg-muted/60 dark:bg-muted/40 rounded-lg pl-8 pr-7 py-1.5 text-xs outline-none text-foreground placeholder:text-muted-foreground/60 border border-transparent focus:border-border transition-colors"
                                                />
                                                {modelSearchQuery && (
                                                    <button
                                                        type="button"
                                                        aria-label={t("composer.clearSearch")}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setModelSearchQuery("");
                                                        }}
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
                                                    >
                                                        <LuX className="h-3 w-3" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex-1 min-h-0 max-h-[320px] overflow-y-auto overscroll-contain flex flex-col gap-0.5 pr-0.5 pb-1.5 scrollbar-thin">
                                        {displayModelsList.map((item) => {
                                            const itemKey = extractModelKey(item.name);
                                            const activeVariantTier = findVariantTierForModel(item, currentModel);
                                            const isActive = itemKey === extractModelKey(currentModel) || Boolean(activeVariantTier);
                                            const itemSpec = item.reasoningSpec;
                                            const preferredTier = isActive
                                                ? resolvedActiveTier
                                                : reasoningLevelByModel?.[itemKey] ?? itemSpec.defaultTier;
                                            const effectiveTier = activeVariantTier ?? resolveModelReasoningTier(itemSpec, preferredTier);
                                            const effortLabel = itemSpec.isReasoning
                                                ? t(`composer.reasoning.${effectiveTier}`, {
                                                      defaultValue:
                                                          effectiveTier === "none"
                                                              ? "Off"
                                                              : effectiveTier === "on"
                                                                ? "On"
                                                                : effectiveTier,
                                                  })
                                                : "";
                                            const targetModelForTier = (tierLevel: ReasoningTier) =>
                                                item.variantMap?.[tierLevel] || item.variantMap?.[itemSpec.defaultTier] || item.name;

                                            if (itemSpec.isReasoning && itemSpec.mode !== "fixed" && itemSpec.tiers.length > 1) {
                                                return (
                                                    <DropdownMenuSub key={item.name}>
                                                        <DropdownMenuSubTrigger
                                                            onClick={() =>
                                                                handleModelSelect(
                                                                    targetModelForTier(effectiveTier),
                                                                    effectiveTier
                                                                )
                                                            }
                                                            className={cn(
                                                                "flex items-center justify-between w-full px-3 py-2 rounded-xl text-sm font-medium transition-colors cursor-pointer select-none outline-none",
                                                                isActive
                                                                    ? "bg-accent text-accent-foreground font-semibold"
                                                                    : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                                                            )}
                                                            title={item.displayName}
                                                        >
                                                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                                                <span
                                                                    className="truncate text-sm font-medium text-foreground"
                                                                    title={item.displayName}
                                                                >
                                                                    {item.displayName}
                                                                </span>
                                                                {renderModelBadges(item)}
                                                            </div>
                                                            <div className="flex items-center gap-2 shrink-0 ml-2">
                                                                <span className="text-xs text-muted-foreground font-normal shrink-0">
                                                                    {effortLabel}
                                                                </span>
                                                                {item.isNew && (
                                                                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border leading-none">
                                                                        {t("composer.badgeNew")}
                                                                    </span>
                                                                )}
                                                                {item.isNotice && (
                                                                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground flex items-center gap-1 border border-border leading-none">
                                                                        {t("composer.badgeNotice")} <LuInfo className="h-3 w-3" />
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </DropdownMenuSubTrigger>
                                                        <DropdownMenuSubContent
                                                            sideOffset={6}
                                                            className="min-w-[144px] w-40 p-1.5 rounded-xl bg-popover border border-border text-popover-foreground shadow-xl z-[1250]"
                                                        >
                                                            {itemSpec.tiers.map((level) => {
                                                                const isSelected = isActive && resolvedActiveTier === level;
                                                                const label = t(`composer.reasoning.${level}`, {
                                                                    defaultValue:
                                                                        level === "none" ? "Off" : level === "on" ? "On" : level,
                                                                });
                                                                return (
                                                                    <DropdownMenuItem
                                                                        key={level}
                                                                        onClick={() => handleModelSelect(targetModelForTier(level), level)}
                                                                        className={cn(
                                                                            "flex items-center justify-between px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors outline-none",
                                                                            isSelected
                                                                                ? "font-semibold text-accent-foreground bg-accent"
                                                                                : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                                                                        )}
                                                                    >
                                                                        <span>{label}</span>
                                                                        {isSelected && (
                                                                            <LuCheck className="h-4 w-4 ml-auto text-primary stroke-[2.5]" />
                                                                        )}
                                                                    </DropdownMenuItem>
                                                                );
                                                            })}
                                                        </DropdownMenuSubContent>
                                                    </DropdownMenuSub>
                                                );
                                            }

                                            return (
                                                <DropdownMenuItem
                                                    key={item.name}
                                                    onClick={() =>
                                                        handleModelSelect(
                                                            targetModelForTier(itemSpec.defaultTier),
                                                            itemSpec.isReasoning ? itemSpec.defaultTier : undefined
                                                        )
                                                    }
                                                    className={cn(
                                                        "flex items-center justify-between w-full px-3 py-2 rounded-xl text-sm font-medium transition-colors cursor-pointer select-none outline-none",
                                                        isActive
                                                            ? "bg-accent text-accent-foreground font-semibold"
                                                            : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                                                    )}
                                                    title={item.displayName}
                                                >
                                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                                        <span
                                                            className="truncate text-sm font-medium text-foreground"
                                                            title={item.displayName}
                                                        >
                                                            {item.displayName}
                                                        </span>
                                                        {renderModelBadges(item)}
                                                    </div>
                                                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                                        {itemSpec.isReasoning && (
                                                            <span className="text-xs text-muted-foreground font-normal shrink-0">
                                                                {effortLabel}
                                                            </span>
                                                        )}
                                                        {item.isNew && (
                                                            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border leading-none">
                                                                {t("composer.badgeNew")}
                                                            </span>
                                                        )}
                                                        {item.isNotice && (
                                                            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground flex items-center gap-1 border border-border leading-none">
                                                                {t("composer.badgeNotice")} <LuInfo className="h-3 w-3" />
                                                            </span>
                                                        )}
                                                        {isActive && (
                                                            <LuCheck className="h-4 w-4 text-primary shrink-0" />
                                                        )}
                                                    </div>
                                                </DropdownMenuItem>
                                            );
                                        })}

                                        {displayModelsList.length === 0 && (
                                            <div className="py-6 text-center text-xs text-muted-foreground">
                                                {t("composer.noModelsFound")}
                                            </div>
                                        )}
                                    </div>

                                    <div className="shrink-0 pt-0.5">
                                        <DropdownMenuSeparator className="mx-1 my-1.5 h-px bg-border" />

                                        <DropdownMenuItem
                                            onClick={() => {
                                                useWorkspacesStore.getState().setWorkspaceSettingsDialogOpen(true, "logs");
                                            }}
                                            className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-muted-foreground hover:text-foreground hover:bg-accent/60 cursor-pointer transition-colors outline-none"
                                        >
                                            <LuGauge className="h-4 w-4 text-muted-foreground shrink-0" />
                                            <span className="font-medium text-sm flex-1 text-foreground">{t("composer.viewUsage")}</span>
                                            <LuChevronRight className="h-4 w-4 text-muted-foreground/70 shrink-0 ml-auto" />
                                        </DropdownMenuItem>
                                    </div>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </div>

                    {/* Right Controls */}
                    <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-1.5">
                        {/* Character count when approaching limit */}
                        {message.length > maxLength * 0.75 && (
                            <span
                                className={cn(
                                    "shrink-0 text-[11px] tabular-nums font-mono px-1 transition-colors hidden sm:inline-block",
                                    message.length >= maxLength ? "text-rose-500 font-semibold" : "text-muted-foreground/70"
                                )}
                            >
                                {message.length}/{maxLength}
                            </span>
                        )}

                        {/* Voice Input */}
                        <div className="flex items-center gap-1.5">
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                onClick={handleMicrophoneClick}
                                className={cn(
                                    "h-8 w-8 sm:h-8.5 sm:w-8.5 rounded-full transition-all",
                                    isListening
                                        ? "bg-rose-500/15 text-rose-500 ring-2 ring-rose-500/30 animate-pulse hover:bg-rose-500/25"
                                        : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                                )}
                                title={isListening ? t("composer.listeningStopTitle") : t("composer.voiceInput")}
                                aria-label={t("composer.voiceInput")}
                            >
                                <LuMic className="h-4 w-4" />
                            </Button>
                            {isListening && (
                                <span className="text-xs font-medium text-rose-500 animate-pulse hidden sm:inline-flex items-center gap-1.5">
                                    <span className="h-2 w-2 rounded-full bg-rose-500 animate-ping" />
                                    {t("composer.listening")}
                                </span>
                            )}
                        </div>

                        {/* Send / Stop Button */}
                        {loading && onCancel ? (
                            <Button
                                type="button"
                                size="icon"
                                variant="destructive"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void onCancel();
                                }}
                                className="h-8 w-8 sm:h-8.5 sm:w-8.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white shadow-md shadow-rose-600/30 transition-all active:scale-95 flex items-center justify-center shrink-0 group cursor-pointer"
                                title={t("composer.stopGeneration")}
                                aria-label={t("composer.stopGeneration")}
                            >
                                <LuSquare className="h-3 w-3 fill-current group-hover:scale-90 transition-transform" />
                            </Button>
                        ) : (
                            <Button
                                type="button"
                                size="icon"
                                onClick={handleSend}
                                disabled={isSendDisabled}
                                className={cn(
                                    "h-8 w-8 sm:h-8.5 sm:w-8.5 rounded-full flex items-center justify-center transition-all duration-200 shrink-0",
                                    hasContent && !loading && !disabled
                                        ? "bg-foreground text-background hover:bg-foreground/90 shadow-sm hover:scale-105 active:scale-95 cursor-pointer group"
                                        : "bg-muted text-muted-foreground/40 cursor-not-allowed border-0 shadow-none"
                                )}
                                title={hasContent ? t("composer.sendMessageShortcut") : t("composer.typeMessageToSend")}
                                aria-label={t("composer.sendMessage")}
                            >
                                {loading ? (
                                    <LuLoader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <LuArrowUp className={cn("h-4 w-4 stroke-[2.5] transition-transform", hasContent && "group-hover:-translate-y-0.5")} />
                                )}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PromptInput;
