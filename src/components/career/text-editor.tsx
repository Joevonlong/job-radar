"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Text, Wording } from "@/lib/career/schema/profile";

export function blankText(): Text {
  return {
    id: "",
    primary: "",
    wordings: [
      {
        id: "",
        text: "",
        lang: null,
        label: null,
        origin: "manual",
        from_document: null,
        from_story: null,
        created_at: new Date().toISOString(),
      },
    ],
  };
}

export function TextEditor({
  value,
  onChange,
  maxWordings,
  maxChars,
}: {
  value: Text;
  onChange: (text: Text) => void;
  maxWordings: number;
  maxChars: number;
}) {
  const t = useTranslations("career");
  const change = (index: number, patch: Partial<Wording>) =>
    onChange({
      ...value,
      wordings: value.wordings.map((wording, at) => (at === index ? { ...wording, ...patch } : wording)),
    });
  function setPrimary(index: number) {
    const selected = value.wordings[index]!;
    if (selected.id) onChange({ ...value, primary: selected.id });
    else onChange({ ...value, primary: "", wordings: [selected, ...value.wordings.filter((_, at) => at !== index)] });
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {value.wordings.map((wording, index) => {
        const primary = value.primary ? wording.id === value.primary : index === 0;
        return (
          <div
            key={wording.id || `new-${index}`}
            className="flex min-w-0 flex-col gap-2 rounded-card border-bw border-grid p-3"
          >
            <label className="flex min-w-0 flex-col gap-1 text-label">
              {t("wording", { number: index + 1 })}
              <Textarea
                aria-label={t("wording", { number: index + 1 })}
                value={wording.text}
                maxLength={maxChars}
                onChange={(event) => change(index, { text: event.target.value })}
              />
            </label>
            <div className="grid min-w-0 gap-2 md:grid-cols-2">
              <label className="text-label">
                {t("fields.lang")}
                <Input
                  value={wording.lang ?? ""}
                  onChange={(event) => change(index, { lang: event.target.value || null })}
                />
              </label>
              <label className="text-label">
                {t("fields.label")}
                <Input
                  value={wording.label ?? ""}
                  maxLength={maxChars}
                  onChange={(event) => change(index, { label: event.target.value || null })}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" aria-pressed={primary} onClick={() => setPrimary(index)}>
                {primary ? t("primary") : t("setPrimary")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={primary}
                onClick={() => onChange({ ...value, wordings: value.wordings.filter((_, at) => at !== index) })}
              >
                {t("deleteWording")}
              </Button>
            </div>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        disabled={value.wordings.length >= maxWordings}
        onClick={() => onChange({ ...value, wordings: [...value.wordings, blankText().wordings[0]!] })}
      >
        {t("addWording")}
      </Button>
    </div>
  );
}
