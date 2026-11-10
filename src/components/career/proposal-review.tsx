"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type messages from "../../../messages/en.json";
import { loadDocumentAction } from "@/app/career/documents/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { documentObjects, documentTexts } from "@/lib/career/document/targets";
import type { CareerDocument } from "@/lib/career/schema/document";
import type { Proposal, Proposals } from "@/lib/career/tailor/proposal-schema";
import { ClaimLine } from "./claim-marks";
import { TranslationConfirm } from "./claim-translation";
import { ProposalDiff } from "./proposal-diff";
import { callTailor, proposalsReplySchema, tailorAction } from "./tailor-api";

type Loaded = { document: CareerDocument; baseHash: string };
type Review = { proposals: Proposals | null; changed: boolean; doc: Loaded };
type ErrorKey = `errors.${keyof typeof messages.career.tailor.errors}`;
const STRUCTURE = new Set(["include", "drop", "reorder"]);
const SECTIONS = new Set(["experience", "projects", "education", "certifications", "languages", "skills", "approach", "custom_sections", "letter.body"]);

async function fetchReview(docId: string): Promise<Review | string> {
  const [reply, loaded] = await Promise.all([
    callTailor(proposalsReplySchema, `/api/career/tailor/proposals?doc_id=${encodeURIComponent(docId)}`),
    loadDocumentAction({ id: docId }).catch(() => ({ ok: false as const, code: "unavailable" })),
  ]);
  if (!reply.ok) return reply.error;
  if (!loaded.ok) return loaded.code;
  return { proposals: reply.proposals, changed: reply.document_changed, doc: { document: loaded.document, baseHash: loaded.baseHash } };
}

/** A short human name for a document object: an entry's company, name, school, group or title, or a text's own words. */
export function objectLabel(doc: CareerDocument, id: string): string {
  const object = documentObjects(doc).get(id);
  if (!object) return id;
  for (const key of ["company", "name", "school", "group", "title", "role", "heading", "text"]) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object" && "text" in value && typeof value.text === "string" && value.text.trim()) return value.text;
  }
  return id;
}

function targetExists(doc: CareerDocument, item: Proposal): boolean {
  const target = item.target;
  const objects = documentObjects(doc);
  if ("text" in target) return objects.has(target.text);
  if ("entry" in target) return objects.has(target.entry);
  if ("list" in target) return SECTIONS.has(target.list) || objects.has(target.list.split(".")[0] ?? "");
  return true;
}

function beforeText(doc: CareerDocument, item: Proposal): string {
  const target = item.target;
  if ("text" in target) return documentTexts(doc).find((entry) => entry.value.id === target.text)?.value.text ?? "";
  if ("letter" in target) {
    const value = doc.letter?.[target.letter];
    return Array.isArray(value) ? value.join("\n") : value ?? "";
  }
  return "";
}

/** Proposals are reviewed one by one: the selection and order apart from the wording, each with its evidence and marks. */
export function ProposalReview({ docId }: { docId: string }) {
  const t = useTranslations("career.proposals");
  const te = useTranslations("career.tailor");
  const [review, setReview] = useState<Review | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchReview(docId).then((result) => {
      if (!active) return;
      if (typeof result === "string") setFailure(result);
      else setReview(result);
    });
    return () => { active = false; };
  }, [docId, revision]);
  async function decide(item: Proposal, action: "accept" | "reject") {
    if (!review) return;
    setBusy(true); setFailure(null);
    try {
      const result = await tailorAction({ action, doc_id: docId, baseHash: review.doc.baseHash, item_id: item.id });
      if (!result.ok) { setFailure(result.error); if (result.error === "target_gone") setGone((old) => new Set(old).add(item.id)); }
      else if ("state" in result && result.state === "target_gone") setGone((old) => new Set(old).add(item.id));
      setRevision((value) => value + 1);
    } finally { setBusy(false); }
  }
  if (!review) return failure ? <p role="alert" data-code={failure}>{t("loadFailed")}</p> : null;
  const items = review.proposals?.items ?? [];
  const errorKey = `errors.${failure}` as ErrorKey;
  const doc = review.doc.document;
  const section = (structure: boolean) => items.filter((item) => STRUCTURE.has(item.action) === structure);
  return (
    <section data-testid="proposal-review" aria-label={t("title")} className="flex min-w-0 flex-col gap-4">
      <h3 className="text-title-sm font-bold">{t("title")}</h3>
      <TranslationConfirm document={doc} baseHash={review.doc.baseHash} disabled={busy} onSaved={() => setRevision((value) => value + 1)} />
      {review.changed && items.length > 0 && <p role="note" data-testid="proposal-changed">{t("documentChanged")}</p>}
      {failure && <p role="alert" data-code={failure} className="break-words text-bad">{te.has(errorKey) ? te(errorKey) : te("errors.generic")}</p>}
      {items.length === 0 ? <p>{t("none")}</p> : ([true, false] as const).map((structure) => (
        <div key={String(structure)} className="flex min-w-0 flex-col gap-3" data-testid={structure ? "proposal-structure" : "proposal-wording"}>
          <h4 className="text-label">{t(structure ? "structure" : "wording")}</h4>
          {section(structure).length === 0 ? <p className="text-body-sm">{t("sectionEmpty")}</p> : section(structure).map((item) => {
            const missing = gone.has(item.id) || !targetExists(doc, item);
            const before = beforeText(doc, item);
            const targetId = "text" in item.target ? item.target.text : "entry" in item.target ? item.target.entry : "list" in item.target ? item.target.list.split(".")[0]! : item.target.letter;
            return (
              <article key={item.id} data-testid="proposal-item" data-action={item.action} className="flex min-w-0 flex-col gap-2 rounded-card border-bw border-grid p-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="tag">{t(`actions.${item.action}`)}</Badge>
                  <span className="min-w-0 break-words text-label">{"letter" in item.target ? t(`letter.${item.target.letter}`) : objectLabel(doc, targetId)}</span>
                </div>
                {missing && <p role="note" data-testid="proposal-gone">{t("targetGone")}</p>}
                {item.action === "reorder" && item.order && (
                  <ol className="list-decimal pl-5">{item.order.map((id) => <li key={id} className="break-words">{objectLabel(doc, id)}</li>)}</ol>
                )}
                {item.text !== undefined && item.action !== "reorder" && (
                  <ProposalDiff before={before} after={item.text} labels={{ removed: t("removed"), added: t("added") }} />
                )}
                {item.support.length > 0 && (
                  <div className="min-w-0">
                    <p className="text-label">{t("support")}</p>
                    <ul className="flex min-w-0 flex-col gap-1">
                      {item.support.map((support, index) => (
                        <li key={index} className="break-words text-body-sm">
                          {"quote" in support ? <q>{support.quote}</q> : t("cites", { entry: support.entry === "summary" ? t("summary") : objectLabel(doc, support.entry) })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {item.rationale && <p className="break-words text-body-sm"><span className="text-label">{t("rationale")}</span> {item.rationale}</p>}
                {item.claims.length > 0 && (
                  <ul className="flex min-w-0 flex-col gap-1" aria-label={t("claims")}>
                    {item.claims.map((claim) => <ClaimLine key={claim.id} claim={claim} />)}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" disabled={busy || missing} onClick={() => void decide(item, "accept")}>{t("accept")}</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(item, "reject")}>{t("reject")}</Button>
                </div>
              </article>
            );
          })}
        </div>
      ))}
    </section>
  );
}
