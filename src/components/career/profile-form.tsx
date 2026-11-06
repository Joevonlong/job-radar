"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { saveProfileAction } from "@/app/career/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CareerConfig } from "@/lib/config/schemas/career";
import { profileEntryCount, type CareerProfile } from "@/lib/career/schema/profile";

import { CareerStatus } from "./career-status";
import { ObjectFields, blankEntry, sectionFields, sectionKeys, type DataObject } from "./profile-fields";
import { profilePiiWarnings } from "./pii";

export function ProfileForm({
  profile,
  baseHash,
  limits,
  onSaved,
  onDirty,
  disabled = false,
}: {
  profile: CareerProfile;
  baseHash: string | null;
  limits: CareerConfig["profile"];
  onSaved: (profile: CareerProfile, hash: string) => void;
  onDirty: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("career");
  const [draft, setDraftState] = useState(profile);
  function setDraft(next: CareerProfile) {
    setDraftState(next);
    onDirty(true);
  }
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();
  const warning = profilePiiWarnings(draft).length > 0;
  return (
    <form
      data-testid="career-profile-form"
      className="flex min-w-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || pending) return;
        startTransition(async () => {
          try {
            const result = await saveProfileAction({ profile: draft, baseHash });
            if (!result.ok) {
              setStatus(result.code);
              return;
            }
            setDraftState(result.profile);
            onDirty(false);
            onSaved(result.profile, result.baseHash);
            setStatus(result.warnings.length ? "history_failed" : "saved");
          } catch {
            setStatus("request_failed");
          }
        });
      }}
    >
      <fieldset disabled={pending || disabled} className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {profileEntryCount(draft) === 0 && <p>{t("empty")}</p>}
            <ObjectFields
              value={draft as unknown as DataObject}
              onChange={(value) => setDraft(value as unknown as CareerProfile)}
              fields={[
                { key: "headline", kind: "optionalRich" },
                { key: "summary", kind: "optionalRich" },
              ]}
              limits={limits}
            />
          </CardContent>
        </Card>
        {sectionKeys.map((section) => (
          <Card key={section} data-testid={`career-${section}`}>
            <CardHeader>
              <CardTitle>{t(`sections.${section}`)}</CardTitle>
            </CardHeader>
            <CardContent>
              {draft[section].map((entry, index) => (
                <fieldset
                  key={entry.id || index}
                  className="flex min-w-0 flex-col gap-3 rounded-card border-bw border-grid p-3"
                >
                  <legend className="text-label">
                    {t("sectionEntry", { section: t(`sections.${section}`), number: index + 1 })}
                  </legend>
                  <ObjectFields
                    value={entry as unknown as DataObject}
                    onChange={(next) =>
                      setDraft({ ...draft, [section]: draft[section].map((old, at) => (at === index ? next : old)) })
                    }
                    fields={sectionFields[section]}
                    limits={limits}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setDraft({ ...draft, [section]: draft[section].filter((_, at) => at !== index) })}
                  >
                    {t("removeField", { label: t(`nouns.${section}`) })}
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={profileEntryCount(draft) >= limits.max_entries}
                onClick={() => setDraft({ ...draft, [section]: [...draft[section], blankEntry(section)] })}
              >
                {t("addField", { label: t(`nouns.${section}`) })}
              </Button>
            </CardContent>
          </Card>
        ))}
      </fieldset>
      {warning && (
        <p role="status" className="rounded-card border-bw border-ink bg-soft p-3 text-body-sm">
          {t("pii")}
        </p>
      )}
      <CareerStatus code={status} />
      <Button type="submit" disabled={pending || disabled}>
        {pending ? t("saving") : t("save")}
      </Button>
    </form>
  );
}
