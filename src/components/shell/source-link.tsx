import { useTranslations } from "next-intl";

import { SOURCE_URL } from "@/lib/docs-link";

import pkg from "../../../package.json";

/** The running version and a link to its source code, at the foot of the sidebar (AGPL-3.0 section 13 asks for a way to get the source). */
export function SourceLink() {
  const t = useTranslations("shell");
  return (
    <p className="px-sp-2 pt-sp-2 text-cap text-term-dim" data-testid="source-link">
      <span>v{pkg.version}</span>
      {" · "}
      <a href={`${SOURCE_URL}/tree/v${pkg.version}`} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
        {t("sourceLink")}
      </a>
    </p>
  );
}
