"use client";

import { useTranslations } from "next-intl";
import type messages from "../../../messages/en.json";
import type { DocumentFinding } from "@/lib/career/render/check-result";

type CheckMessages = typeof messages.career.documents.checks;
type CheckKey = {
  [Group in keyof CheckMessages]: `checks.${Group}.${keyof CheckMessages[Group] & string}`;
}[keyof CheckMessages];

export function DocumentChecks({ findings }: { findings: DocumentFinding[] }) {
  const t = useTranslations("career.documents");
  function message(finding: DocumentFinding) {
    const key = `checks.${finding.code.replace(/^career\./, "")}` as CheckKey;
    return t.has(key) ? t(key, finding.params) : t("checkUnknown");
  }
  return (
    <section aria-label={t("checksTitle")} className="min-w-0 break-words" data-testid="document-checks">
      <h3 className="font-semibold">{t("checksTitle")}</h3>
      <ul className="flex flex-col gap-2 text-body-sm">
        {findings.map((finding, index) => (
          <li
            key={index}
            className={finding.severity === "error"
              ? "rounded-card border-bw border-grid bg-soft p-2 font-semibold"
              : ""}
          >
            {message(finding)}
            {finding.path && <span className="ml-2 font-mono text-data text-ink-2">{finding.path}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
