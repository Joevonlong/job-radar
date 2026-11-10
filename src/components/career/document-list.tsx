"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { createDocumentAction, deleteDocumentAction } from "@/app/career/documents/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { resolveLocale } from "@/i18n/locale";
import type { DocumentSummary } from "@/lib/career/store/documents";
import { formatFullTime } from "@/lib/format/time";
import { DocumentConfirm, DocumentInput, DocumentStatus } from "./document-shared";

export function DocumentListPage({
  documents,
  profileEmpty,
  profileUnreadable = false,
  timeZone,
}: {
  documents: DocumentSummary[];
  profileEmpty: boolean;
  profileUnreadable?: boolean;
  timeZone: string;
}) {
  const t = useTranslations("career.documents");
  const locale = resolveLocale(useLocale());
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function create() {
    startTransition(async () => {
      try {
        const result = await createDocumentAction(title.trim() ? { title } : {});
        if (!result.ok) {
          setCode(result.code);
          return;
        }
        router.push(`/career/documents/${result.id}`);
      } catch {
        setCode("request_failed");
      }
    });
  }
  function remove() {
    startTransition(async () => {
      try {
        const result = await deleteDocumentAction({ id: selected, confirmed: true });
        if (!result.ok) {
          setCode(result.code);
          return;
        }
        setSelected(null);
        router.refresh();
      } catch {
        setCode("request_failed");
      }
    });
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {profileEmpty ? (
        <p>
          {t(profileUnreadable ? "status.profile_unreadable" : "profileEmpty")}{" "}
          <Link href="/career" className="underline">
            {t("profileLink")}
          </Link>
        </p>
      ) : (
        <Card>
          <CardContent>
            <DocumentInput label={t("optionalTitle")} value={title} onChange={setTitle} />
            <Button disabled={pending} onClick={create}>
              {t("create")}
            </Button>
          </CardContent>
        </Card>
      )}
      <DocumentStatus code={code} />
      {documents.length === 0 && <p>{t("empty")}</p>}
      <ul className="flex min-w-0 flex-col gap-3">
        {documents.map((document) => (
          <li key={document.id}>
            <Card>
              <CardContent>
                {"invalid" in document ? (
                  <p>{t("invalidFile")}</p>
                ) : (
                  <>
                    <h2 className="break-words text-title">{document.title}</h2>
                    <p>
                      {t(`options.${document.lang}`)}
                      {" · "}
                      <time dateTime={document.updatedAt}>
                        {formatFullTime(document.updatedAt, { locale, timeZone })}
                      </time>
                    </p>
                  </>
                )}
                <div className="flex flex-wrap gap-3">
                  <Link href={`/career/documents/${document.id}`} className="underline">
                    {t("open")}
                  </Link>
                  <Button variant="outline" disabled={pending} onClick={() => setSelected(document.id)}>
                    {t("delete")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <DocumentConfirm
        open={selected !== null}
        title={t("delete")}
        pending={pending}
        onClose={() => setSelected(null)}
        onConfirm={remove}
      />
    </div>
  );
}
