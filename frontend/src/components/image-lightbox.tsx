"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { FaChevronLeft, FaChevronRight, FaTimes } from "react-icons/fa";
import type { ImageData } from "@/stores/chat";
import { cn, formatModelIdentifier } from "@/lib/utils";

interface ImageLightboxProps {
  open: boolean;
  onClose: () => void;
  images: ImageData[];
  initialIndex?: number;
}

const ImageLightbox = ({
  open,
  onClose,
  images,
  initialIndex = 0,
}: ImageLightboxProps) => {
  const { t } = useTranslation("chat");
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const currentImage = images[currentIndex];

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, open]);

  const goTo = useCallback(
    (index: number) => {
      if (index >= 0 && index < images.length) {
        setCurrentIndex(index);
      }
    },
    [images.length]
  );

  const goPrev = useCallback(() => goTo(currentIndex - 1), [goTo, currentIndex]);
  const goNext = useCallback(() => goTo(currentIndex + 1), [goTo, currentIndex]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, goPrev, goNext, onClose]);

  if (!currentImage) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-[1200] bg-black/95 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 duration-200" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[1200] flex flex-col justify-between p-0 m-0 outline-none text-white select-none origin-center data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-200"
        >
          <DialogTitle className="sr-only">{currentImage.prompt || t("lightbox.imagePreview")}</DialogTitle>
          <DialogDescription className="sr-only">{t("lightbox.fullScreenDescription")}</DialogDescription>

          {/* Top bar */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute top-0 left-0 right-0 z-20 flex justify-between items-center p-4"
          >
            <span className="text-sm opacity-70">
              {currentIndex + 1} / {images.length}
            </span>
            <button
              type="button"
              aria-label={t("lightbox.close")}
              className="p-2 rounded-full hover:bg-white/10 text-white transition-colors cursor-pointer"
              onClick={onClose}
            >
              <FaTimes className="h-4 w-4" />
            </button>
          </motion.div>

          {/* Center image view */}
          <div
            className="flex-1 flex items-center justify-center relative w-full h-full p-4 overflow-hidden"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            {/* Previous button */}
            {images.length > 1 && (
              <button
                type="button"
                aria-label={t("lightbox.previous")}
                className={cn(
                  "absolute left-4 top-1/2 -translate-y-1/2 z-20 p-3 rounded-full hover:bg-white/10 text-white transition-colors cursor-pointer",
                  currentIndex === 0 && "opacity-30 cursor-not-allowed"
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  goPrev();
                }}
                disabled={currentIndex === 0}
              >
                <FaChevronLeft className="h-6 w-6" />
              </button>
            )}

            <AnimatePresence mode="wait">
              <motion.img
                key={currentImage.image_url || currentIndex}
                src={currentImage.image_url}
                alt={currentImage.prompt}
                initial={{ scale: 0.78, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.85, opacity: 0 }}
                transition={{
                  duration: 0.25,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="max-h-[75vh] max-w-[90vw] object-contain rounded-lg shadow-2xl origin-center cursor-default"
                onClick={(e) => e.stopPropagation()}
              />
            </AnimatePresence>

            {/* Next button */}
            {images.length > 1 && (
              <button
                type="button"
                aria-label={t("lightbox.next")}
                className={cn(
                  "absolute right-4 top-1/2 -translate-y-1/2 z-20 p-3 rounded-full hover:bg-white/10 text-white transition-colors cursor-pointer",
                  currentIndex === images.length - 1 && "opacity-30 cursor-not-allowed"
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  goNext();
                }}
                disabled={currentIndex === images.length - 1}
              >
                <FaChevronRight className="h-6 w-6" />
              </button>
            )}
          </div>

          {/* Bottom metadata */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="p-4 bg-black/70 backdrop-blur-md z-20"
          >
            <p className="text-sm font-semibold line-clamp-2 mb-1">
              {currentImage.prompt}
            </p>
            <div className="flex items-center gap-4 text-xs opacity-70 flex-wrap">
              {currentImage.model && (
                <span>
                  {t("lightbox.model", { model: formatModelIdentifier(currentImage.model, currentImage.tag) })}
                </span>
              )}
              {currentImage.seed != null && (
                <span className="font-bold">{t("lightbox.seed", { seed: currentImage.seed })}</span>
              )}
              {currentImage.width && currentImage.height && (
                <span>
                  {currentImage.width} &times; {currentImage.height}
                </span>
              )}
            </div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};

export default ImageLightbox;
