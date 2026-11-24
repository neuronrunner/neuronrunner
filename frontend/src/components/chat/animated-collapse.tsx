"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";

interface AnimatedCollapseProps {
  in: boolean;
  children: ReactNode;
}

export default function AnimatedCollapse({ in: open, children }: AnimatedCollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
