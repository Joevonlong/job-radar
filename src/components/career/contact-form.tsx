"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { saveContactAction } from "@/app/career/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { CareerContact } from "@/lib/career/schema/contact";

import { CareerStatus } from "./career-status";

const fields = ["name", "address", "location", "email", "phone", "work_auth", "availability"] as const;
export function ContactForm({ initial, initialHash }: { initial: CareerContact; initialHash: string | null }) {
  const t = useTranslations("career");
  const [contact, setContact] = useState(initial);
  const [baseHash, setHash] = useState(initialHash);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("contact")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-body-sm text-ink-2">{t("contactNote")}</p>
        <form
          data-testid="career-contact-form"
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              try {
                const result = await saveContactAction({ contact, baseHash });
                if (!result.ok) {
                  setStatus(result.code);
                  return;
                }
                setContact(result.contact);
                setHash(result.baseHash);
                setStatus("saved");
              } catch {
                setStatus("request_failed");
              }
            });
          }}
        >
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
            {fields.map((key) => (
              <label className="flex min-w-0 flex-col gap-1 text-label" key={key}>
                {t(`fields.${key}`)}
                <Input
                  value={contact[key] ?? ""}
                  onChange={(event) => setContact({ ...contact, [key]: event.target.value || null })}
                />
              </label>
            ))}
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="text-label">{t("fields.links")}</legend>
              {contact.links.map((link, index) => (
                <div className="flex min-w-0 flex-col gap-2 rounded-card border-bw border-grid p-3" key={index}>
                  <label className="text-label">
                    {t("fields.label")}
                    <Input
                      value={link.label}
                      onChange={(event) =>
                        setContact({
                          ...contact,
                          links: contact.links.map((old, at) =>
                            at === index ? { ...old, label: event.target.value } : old,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="text-label">
                    {t("fields.url")}
                    <Input
                      type="url"
                      value={link.url}
                      onChange={(event) =>
                        setContact({
                          ...contact,
                          links: contact.links.map((old, at) =>
                            at === index ? { ...old, url: event.target.value } : old,
                          ),
                        })
                      }
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setContact({ ...contact, links: contact.links.filter((_, at) => at !== index) })}
                  >
                    {t("remove")}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() => setContact({ ...contact, links: [...contact.links, { label: "", url: "" }] })}
              >
                {t("addField", { label: t("nouns.links") })}
              </Button>
            </fieldset>
            <Button type="submit">{pending ? t("saving") : t("saveContact")}</Button>
          </fieldset>
        </form>
        <CareerStatus code={status} />
      </CardContent>
    </Card>
  );
}
