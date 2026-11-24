"use client";

import { LuX, LuUpload } from "react-icons/lu";
import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface ProfilePictureProps {
  onUpload?: (file: File) => void;
  onRemove?: () => void;
  image?: string;
  size?: string;
  id?: string;
  disabled?: boolean;
  shape?: "circle" | "rounded";
  className?: string;
}

const ProfilePicture = ({
  onUpload,
  onRemove,
  image,
  size = "80px",
  id = "profile-picture-input",
  disabled = false,
  shape = "circle",
  className,
}: ProfilePictureProps) => {
  const { t } = useTranslation("common");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (image) {
      setPreviewUrl(image);
    } else {
      setPreviewUrl(null);
    }
  }, [image]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const files = event.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      if (onUpload) {
        onUpload(file);
      }
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    if (disabled) return;
    e.stopPropagation();
    setPreviewUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (onRemove) {
      onRemove();
    }
  };

  const roundedClass = shape === "rounded" ? "rounded-2xl" : "rounded-full";

  return (
    <div className={cn("relative flex-shrink-0", className)} style={{ width: size, height: size }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
        id={id}
        disabled={disabled}
      />

      {!previewUrl ? (
        <label
          htmlFor={disabled ? undefined : id}
          className={cn(
            "block w-full h-full",
            disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          )}
        >
          <div
            style={{ width: size, height: size }}
            className={cn(
              roundedClass,
              "border-2 border-dashed border-border flex flex-col items-center justify-center gap-1.5 transition-all",
              !disabled && "hover:border-foreground/40 hover:bg-muted/50 cursor-pointer"
            )}
          >
            <LuUpload className="h-5 w-5 text-muted-foreground" />
            <span className="text-[11px] font-medium text-muted-foreground text-center px-1">
              {t("common.upload")}
            </span>
          </div>
        </label>
      ) : (
        <>
          <label
            htmlFor={disabled ? undefined : id}
            className={cn(
              "block relative w-full h-full group",
              disabled ? "cursor-not-allowed opacity-80" : "cursor-pointer"
            )}
          >
            <div
              style={{ width: size, height: size }}
              className={cn(roundedClass, "overflow-hidden bg-muted border border-border relative")}
            >
              <div
                className="w-full h-full bg-cover bg-center transition-transform duration-300 group-hover:scale-105"
                style={{ backgroundImage: `url(${previewUrl})` }}
              />
              {!disabled && (
                <div
                  className={cn(
                    roundedClass,
                    "absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center text-white gap-1 transition-opacity duration-200"
                  )}
                >
                  <LuUpload className="h-4 w-4" />
                  <span className="text-[10px] font-medium tracking-wide">{t("common.change")}</span>
                </div>
              )}
            </div>
          </label>

          {!disabled && (
            <button
              type="button"
              className="absolute top-0 right-0 w-6 h-6 bg-background dark:bg-zinc-800 border border-border rounded-full flex items-center justify-center hover:bg-destructive hover:border-destructive hover:text-destructive-foreground cursor-pointer shadow-md transform translate-x-[25%] -translate-y-[25%] z-10 transition-colors"
              onClick={handleRemove}
              aria-label={t("common.removePicture")}
            >
              <LuX className="h-3.5 w-3.5 text-muted-foreground hover:text-white transition-colors" />
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default ProfilePicture;