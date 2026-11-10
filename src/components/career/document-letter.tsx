"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { CareerDocument } from "@/lib/career/schema/document";
import type { SourceStates } from "@/lib/career/document/resolve";
import { DocumentBullets } from "./document-fields";
import { DocumentConfirm, DocumentInput } from "./document-shared";

export function DocumentLetter({
  letter,
  states,
  onChange,
}: {
  letter: CareerDocument["letter"];
  states: SourceStates;
  onChange: (letter: CareerDocument["letter"]) => void;
}) {
  const t = useTranslations("career.documents");
  const [confirm, setConfirm] = useState(false);
  if (letter === null) {
    return (
      <Button
        variant="outline"
        onClick={() =>
          onChange({ recipient: [], place: null, date: null, subject: null, salutation: null, body: [], closing: null })
        }
      >
        {t("addLetter")}
      </Button>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <DocumentInput
        label={t("letterFields.recipient")}
        value={letter.recipient.join("\n")}
        multiline
        onChange={(value) => onChange({ ...letter, recipient: value ? value.split("\n") : [] })}
      />
      {(["place", "date", "subject", "salutation"] as const).map((field) => (
        <DocumentInput
          key={field}
          label={t(`letterFields.${field}`)}
          value={letter[field]}
          type={field === "date" ? "date" : "text"}
          onChange={(value) => onChange({ ...letter, [field]: value || null })}
        />
      ))}
      <DocumentBullets
        label={t("letterFields.body")}
        value={letter.body}
        onChange={(body) => onChange({ ...letter, body })}
        states={states}
      />
      <DocumentInput
        label={t("letterFields.closing")}
        value={letter.closing}
        onChange={(closing) => onChange({ ...letter, closing: closing || null })}
      />
      <Button variant="outline" onClick={() => setConfirm(true)}>
        {t("removeLetter")}
      </Button>
      <DocumentConfirm
        open={confirm}
        title={t("removeLetter")}
        pending={false}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          onChange(null);
          setConfirm(false);
        }}
      />
    </div>
  );
}
