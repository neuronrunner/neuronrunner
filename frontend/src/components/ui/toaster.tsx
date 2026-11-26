"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast as sonnerToast, Toaster as SonnerToaster } from "sonner";
import { useTheme } from "next-themes";

const TOAST_DURATION_MS = 2500;

const scheduleAutoDismiss = (id: string | number) => {
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      sonnerToast.dismiss(id);
    }, TOAST_DURATION_MS + 100);
  }
  return id;
};

type ToastArg = string | {
  title?: React.ReactNode;
  description?: React.ReactNode;
  duration?: number;
  [key: string]: any;
};

const extractToastParams = (
  msgOrOpts: ToastArg,
  desc?: string
): [string, { description?: string; duration: number }] => {
  if (typeof msgOrOpts === "object" && msgOrOpts !== null) {
    const title = msgOrOpts.title
      ? String(msgOrOpts.title)
      : msgOrOpts.description
      ? String(msgOrOpts.description)
      : "";
    const description =
      msgOrOpts.title && msgOrOpts.description
        ? String(msgOrOpts.description)
        : undefined;
    return [title, { description, duration: TOAST_DURATION_MS }];
  }
  return [String(msgOrOpts ?? ""), { description: desc, duration: TOAST_DURATION_MS }];
};

export const toaster = {
  create: (options: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    type?: "success" | "error" | "info" | "warning" | "loading" | string;
    duration?: number;
  }) => {
    const desc = options.description ? String(options.description) : undefined;
    const title = options.title ? String(options.title) : (desc || "");
    const actualDesc = options.title ? desc : undefined;
    const opts = { description: actualDesc, duration: TOAST_DURATION_MS };
    if (options.type === "error") {
      return scheduleAutoDismiss(sonnerToast.error(title, opts));
    }
    if (options.type === "success") {
      return scheduleAutoDismiss(sonnerToast.success(title, opts));
    }
    if (options.type === "info") {
      return scheduleAutoDismiss(sonnerToast.info(title, opts));
    }
    if (options.type === "warning") {
      return scheduleAutoDismiss(sonnerToast.warning(title, opts));
    }
    return scheduleAutoDismiss(sonnerToast(title, opts));
  },
  success: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return scheduleAutoDismiss(sonnerToast.success(title, opts));
  },
  error: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return scheduleAutoDismiss(sonnerToast.error(title, opts));
  },
  info: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return scheduleAutoDismiss(sonnerToast.info(title, opts));
  },
  warning: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return scheduleAutoDismiss(sonnerToast.warning(title, opts));
  },
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};

export const Toaster = (props: React.ComponentProps<typeof SonnerToaster>) => {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || typeof document === "undefined") {
    return null;
  }

  const { style, toastOptions, ...restProps } = props;

  return createPortal(
    <SonnerToaster
      position="bottom-right"
      closeButton={false}
      duration={TOAST_DURATION_MS}
      theme={(resolvedTheme as "light" | "dark" | "system") || "dark"}
      className="toaster group"
      style={
        {
          zIndex: 999999999,
          ...style,
        } as React.CSSProperties
      }
      toastOptions={{
        duration: TOAST_DURATION_MS,
        style: {
          background: "var(--popover)",
          color: "var(--popover-foreground)",
          border: "1px solid var(--border)",
        },
        ...toastOptions,
      }}
      {...restProps}
    />,
    document.body
  );
};

export default Toaster;
