import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DocumentEditor } from "@/components/career/document-editor";
import { readCareerGate } from "@/lib/config/career-gate";
import { reloadConfig } from "@/lib/config/load";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { tailorEntries } from "@/app/career/tailor/entries";
import { documentHistoryAction, imageStateAction, loadDocumentAction, loadPreferencesAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const gate = await readCareerGate();
  const t = await getTranslations("career");
  if (!gate.enabled) {
    return (
      <div data-testid="career-disabled" className="flex flex-col gap-3">
        <p>{t("disabled")}</p>
        <Link href="/settings?tab=workflow" className="underline">
          {t("settings")}
        </Link>
      </div>
    );
  }
  const { id } = await params;
  const loaded = await loadDocumentAction({ id });
  if (!loaded.ok) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert">{t("documents.loadError")}</p>
        <Link href="/career/documents" className="underline">
          {t("documents.back")}
        </Link>
      </div>
    );
  }
  const [preferences, images, history] = await Promise.all([
    loadPreferencesAction({}),
    imageStateAction({}),
    documentHistoryAction({ id }),
  ]);
  if (!preferences.ok || !images.ok) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert">{t("documents.status.generic")}</p>
        <Link href="/career/documents" className="underline">
          {t("documents.back")}
        </Link>
      </div>
    );
  }
  const config = reloadConfig("career");
  const tailor = await tailorEntries(id);
  return (
    <DocumentEditor
      initial={{ document: loaded.document, baseHash: loaded.baseHash }}
      initialStates={loaded.states}
      preferences={{ preferences: preferences.preferences, baseHash: preferences.baseHash }}
      images={{ photo: images.photo, signature: images.signature }}
      initialVersions={history.ok ? history.versions : []}
      warnings={[...loaded.warnings, ...(!history.ok ? [history.code] : [])]}
      debounceMs={config.preview.debounce_ms}
      pageCountDebounceMs={config.preview.page_count_debounce_ms}
      imageMaxBytes={config.document.image_max_bytes}
      timeZone={getDisplayTimeZone()}
      hasProposals={tailor.hasProposals}
      profileEntries={tailor.entries}
    />
  );
}
