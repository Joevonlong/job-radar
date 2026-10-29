"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { motion } from "@/components/viz";
import { revealInBoard } from "./board-scroll";

/** A positioned scroll ancestor clips absolute card content and lets dnd-kit auto-scroll the column. */
export function ColumnScroll({ label, children }: { label: string; children: ReactNode }) {
  const t = useTranslations("pipeline.column");
  return (
    <motion.div layoutScroll role="region" aria-label={t("scrollLabel", { name: label })} tabIndex={0} data-column-scroll data-testid="column-scroll" className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain" onFocusCapture={(event) => {
      // Native Tab scrolling reveals the focused button only. Keep the rest of its card visible too.
      // Pointer focus happens between mouse-down and click: scrolling here moves the button away from mouse-up.
      if (!event.target.matches(":focus-visible")) return;
      const card = event.target.closest<HTMLElement>('[data-testid="pipeline-card"]');
      const board = event.currentTarget.closest<HTMLElement>('[data-testid="board"]');
      if (card && board) revealInBoard(card, board);
    }}>
      {children}
    </motion.div>
  );
}
