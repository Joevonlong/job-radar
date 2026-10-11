"use client";

import { useTranslations } from "next-intl";

import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { KeyHintsBar, type KeyHint } from "@/components/shell/key-hints-bar";

/** The visible reminder of the list shortcuts (j / k / Enter / s / x / f / u, plus the command palette). The shortcuts themselves live in the lists. */
export function KeyHints() {
  const t = useTranslations("dashboard.keys");
  const hidden = useHiddenStatuses();
  const hints: KeyHint[] = [
    { keys: ["j", "k"], label: t("move") },
    { keys: ["Enter"], label: t("open") },
    ...(hidden.includes("interested") ? [] : [{ keys: ["s"], label: t("interested") }]),
    { keys: ["x"], label: t("ignore") },
    { keys: ["f"], label: t("favorite") },
    { keys: ["u"], label: t("seen") },
    { keys: ["c"], label: t("close") },
    { keys: ["Mod", "K"], label: t("palette") },
  ];
  return <KeyHintsBar hints={hints} label={t("label")} />;
}
