import { useLocale } from "next-intl";
import type { ReactNode } from "react";

import { docsUrl, type DocKey } from "@/lib/docs-link";

import { INK_LINK } from "./ink-link";

/** A link to a section of the user guide (opens in a new tab); the text comes from a rich-text message tag. */
export function DocLink({ doc, children }: { doc: DocKey; children: ReactNode }) {
  const locale = useLocale();
  return (
    <a href={docsUrl(locale, doc)} target="_blank" rel="noopener noreferrer" className={INK_LINK} data-testid={`doc-link-${doc}`}>
      {children}
    </a>
  );
}
