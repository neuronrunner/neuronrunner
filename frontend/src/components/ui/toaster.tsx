"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast as sonnerToast, Toaster as SonnerToaster } from "sonner";
import { useTheme } from "next-themes";

type ToastArg = string | {
  title?: React.ReactNode;
  description?: React.ReactNode;
  duration?: number;
  [key: string]: any;
};

const extractToastParams = (
  msgOrOpts: ToastArg,
  desc?: string
): [string, { description?: string; duration?: number } | undefined] => {
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
    return [title, { description, duration: msgOrOpts.duration }];
  }
  return [String(msgOrOpts ?? ""), desc ? { description: desc } : undefined];
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
    if (options.type === "error") {
      return sonnerToast.error(title, { description: actualDesc, duration: options.duration });
    }
    if (options.type === "success") {
      return sonnerToast.success(title, { description: actualDesc, duration: options.duration });
    }
    if (options.type === "info") {
      return sonnerToast.info(title, { description: actualDesc, duration: options.duration });
    }
    if (options.type === "warning") {
      return sonnerToast.warning(title, { description: actualDesc, duration: options.duration });
    }
    return sonnerToast(title, { description: actualDesc, duration: options.duration });
  },
  success: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return sonnerToast.success(title, opts);
  },
  error: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return sonnerToast.error(title, opts);
  },
  info: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return sonnerToast.info(title, opts);
  },
  warning: (msg: ToastArg, desc?: string) => {
    const [title, opts] = extractToastParams(msg, desc);
    return sonnerToast.warning(title, opts);
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
      theme={(resolvedTheme as "light" | "dark" | "system") || "dark"}
      className="toaster group"
      style={
        {
          zIndex: 999999999,
          ...style,
        } as React.CSSProperties
      }
      toastOptions={{
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
