import type { CareerConfig } from "@/lib/config/schemas/career";
import { locateQuote } from "@/lib/signals/quote";
import { figures, nameCandidates } from "@/lib/writer/verify";
import type { FactPool } from "../ai/view";
import { documentObjects, documentTexts } from "../document/targets";
import type { CareerDocument, Claim } from "../schema/document";
import { newId } from "../schema/ids";
import { visitProfile, type CareerProfile, type Text } from "../schema/profile";
import type { Proposal, ProposalInput } from "./proposal-schema";

export function contentWords(text: string, lang: string, settings: CareerConfig["tailor"]): Set<string> {
  const stop = new Set((settings.stopwords[lang] ?? []).map((word) => word.toLocaleLowerCase()));
  return new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !stop.has(word)));
}
export const normalized = (text: string) => (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
const containsPhrase = (source: string, phrase: string) => ` ${normalized(source)} `.includes(` ${normalized(phrase)} `);
export const hasPlaceholder = (text: string) => /\[(?:email|phone|name|address|link|work_auth|availability|salary|photo|redacted)\]/i.test(text);

export interface VerifyContext {
  doc: CareerDocument; pool: FactPool; profile: CareerProfile; jd: string | null; settings: CareerConfig;
  sentIds: readonly string[]; allowed: readonly ProposalInput["action"][];
}

export function isCrossLanguage(doc: CareerDocument, profile: CareerProfile, textId: string): boolean {
  const target = documentTexts(doc).find((item) => item.value.id === textId);
  if (!target?.value.source || target.letter) return false;
  let source: Text | undefined;
  visitProfile(profile, (object) => { if (object.id === target.value.source?.text_id && "wordings" in object) source = object as Text; });
  const wording = source?.wordings.find((item) => item.id === target.value.source?.wording_id);
  return Boolean(wording?.lang && wording.lang !== doc.layout.lang && !source?.wordings.some((item) => item.lang === doc.layout.lang));
}

export function proposalList(doc: CareerDocument, list: string): unknown[] | null {
  if (list === "letter.body") return doc.letter?.body ?? [];
  if (["experience", "projects", "education", "certifications", "languages", "skills", "approach", "custom_sections"].includes(list)) {
    return (doc as unknown as Record<string, unknown[]>)[list] ?? null;
  }
  const match = /^(ent_[a-z2-7]{10})\.(bullets|stack|items)$/.exec(list);
  if (!match) return null;
  const value = documentObjects(doc).get(match[1]!)?.[match[2]!];
  return Array.isArray(value) ? value : null;
}

export function verifyProposal(input: ProposalInput, context: VerifyContext): Proposal | null {
  const { doc, pool, settings } = context;
  if (!context.allowed.includes(input.action)) return null;
  if (hasPlaceholder(JSON.stringify(input))) return null;
  const validCitation = (id: string) => (id === "summary" || id.startsWith("ent_")) && context.sentIds.includes(id);
  if (input.support.some((support) => "entry" in support && !validCitation(support.entry))) return null;
  const objects = documentObjects(doc);
  const target = input.target;
  const object = "text" in target ? objects.get(target.text) : "entry" in target ? objects.get(target.entry) : undefined;
  if (("text" in target || "entry" in target) && !object) return null;
  if ("text" in target && (!object || typeof object.text !== "string" || !("origin" in object))) return null;
  if ("entry" in target && (!/^(?:ent|itm)_[a-z2-7]{10}$/.test(target.entry) || !object)) return null;
  if ("entry" in target && ["drop", "include"].includes(input.action) && typeof object?.included !== "boolean") return null;
  if ("entry" in target && input.action === "add" && (target.field === "stack" ? !Array.isArray(object?.stack) : target.field === "skills" ? !Array.isArray(object?.items) || !("group" in object!) : true)) return null;
  if ("list" in target && proposalList(doc, target.list) === null) return null;
  if (["rewrite", "shorten"].includes(input.action) && !("text" in target || "letter" in target)) return null;
  if (["include", "drop"].includes(input.action)) {
    if (!("entry" in target || "text" in target)) return null;
    if ("text" in target) {
      let listText = false;
      visitProfile(doc, (value) => {
        for (const key of ["bullets", "body"]) if (Array.isArray(value[key]) && value[key].some((item) => item && typeof item === "object" && "id" in item && item.id === target.text)) listText = true;
      });
      if (!listText) return null;
    }
  }
  if (input.action === "add" && !("list" in target || ("entry" in target && target.field))) return null;
  if (input.action === "reorder" && !("list" in target)) return null;
  if (["rewrite", "shorten", "add"].includes(input.action) && !input.text?.trim()) return null;
  if (input.after && (!("list" in target) || !proposalList(doc, target.list)?.some((item) => item && typeof item === "object" && "id" in item && item.id === input.after))) return null;
  if (input.action === "reorder") {
    const list = "list" in target ? proposalList(doc, target.list)! : [];
    const ids = list.flatMap((item) => item && typeof item === "object" && "id" in item ? [String(item.id)] : []);
    if (!input.order || input.order.length !== ids.length || new Set(input.order).size !== ids.length || input.order.some((id) => !ids.includes(id))) return null;
  }
  if (input.action === "add" && "list" in target && !(target.list.endsWith(".bullets") || target.list.endsWith(".stack") || target.list.endsWith(".items") && "group" in (objects.get(target.list.split(".")[0]!) ?? {}) || target.list === "letter.body")) return null;
  const targetId = "text" in target ? target.text : "entry" in target ? target.entry : "list" in target ? target.list.split(".")[0]! : null;
  if (input.action === "reorder") {
    if (input.order?.some((id) => !context.sentIds.includes(blockIdFor(doc, id)))) return null;
  } else if (targetId && targetId !== "letter" && !context.sentIds.includes(blockIdFor(doc, targetId))) return null;
  const proposal: Proposal = { ...input, id: newId("prp"), claims: [] };
  if (!input.text || ["drop", "include", "reorder"].includes(input.action) || "letter" in target && target.letter === "recipient") return proposal;
  const textTarget = "text" in target ? documentTexts(doc).find((item) => item.value.id === target.text) : undefined;
  const listParent = "list" in target ? /^(ent_[a-z2-7]{10})\./.exec(target.list)?.[1] : undefined;
  const entry = textTarget?.entry ? objects.get(textTarget.entry) : listParent ? objects.get(listParent) : object;
  const source = entry?.source as { entry_id?: string } | null | undefined;
  const localPool = (textTarget?.entry || listParent) && !textTarget?.letter && source?.entry_id ? pool.entries[source.entry_id] ?? pool.all : pool.all;
  const cross = "text" in target && isCrossLanguage(doc, context.profile, target.text);
  const claimTarget: Claim["target"] = "text" in target ? { text: target.text }
    : "letter" in target ? { letter: target.letter }
    : "entry" in target ? { entry: target.entry, field: target.field ?? "stack", value: input.text }
    : "list" in target && listParent && (target.list.endsWith(".stack") || target.list.endsWith(".items"))
      ? { entry: listParent, field: target.list.endsWith(".stack") ? "stack" : "skills", value: input.text }
      : { text: derivedId("dtx", proposal.id) };
  const addClaim = (kind: Claim["kind"], text: string, inJd = false, translation = false) => {
    proposal.claims.push({ id: newId("clm"), target: claimTarget, kind, text, in_jd: inJd, translation, status: "pending", by: "ai" });
  };
  const exempt = [doc.job?.company, doc.job?.title, ...(doc.letter?.recipient ?? [])].filter((value): value is string => Boolean(value));
  const exemptWords = new Set(exempt.flatMap((value) => [...contentWords(value, doc.layout.lang, settings.tailor)]));
  const numericPool = figures(localPool, settings.evidence.figure_units).keys;
  for (const shown of figures(input.text, settings.evidence.figure_units).shown) {
    if ([...figures(shown, settings.evidence.figure_units).keys].some((key) => !numericPool.has(key))) addClaim("figure", shown);
  }
  const poolTokens = new Set(normalized(pool.all).split(" "));
  const newNames = nameCandidates(input.text, doc.layout.lang, settings.tailor).filter((name) => !containsPhrase(pool.all, name) && !normalized(name).split(" ").every((word) => poolTokens.has(word)) && !exempt.some((value) => containsPhrase(value, name)));
  for (const name of newNames) addClaim("skill", name, Boolean(context.jd && containsPhrase(context.jd, name)));
  const words = contentWords(input.text, doc.layout.lang, settings.tailor);
  const knownWords = contentWords(pool.all, doc.layout.lang, settings.tailor);
  const jdWords = contentWords(context.jd ?? "", doc.layout.lang, settings.tailor);
  const nameWords = new Set(newNames.flatMap((name) => [...contentWords(name, doc.layout.lang, settings.tailor)]));
  const jdOnly = [...words].filter((word) => !knownWords.has(word) && jdWords.has(word) && !exemptWords.has(word) && !nameWords.has(word));
  if (jdOnly.length) addClaim("skill", jdOnly.join(", "), true, cross);
  const skillAddition = input.action === "add" && (("entry" in target && target.field) || ("list" in target && (target.list.endsWith(".stack") || target.list.endsWith(".items") || target.list === "skills")));
  if (skillAddition) {
    if (!containsPhrase(pool.all, input.text)) addClaim("skill", input.text);
    return proposal;
  }
  if ("letter" in target) return proposal;
  const letterBody = "list" in target && target.list === "letter.body" || textTarget?.letter;
  const validLetter = input.support.some((support) => "entry" in support && (support.entry === "summary" || support.entry.startsWith("ent_")) && context.sentIds.includes(support.entry));
  const quotes = input.support.flatMap((support) => "quote" in support ? [support.quote] : []);
  const validQuotes = quotes.length > 0 && quotes.every((quote) => locateQuote(localPool, quote) !== null);
  const quoteWords = contentWords(quotes.join(" "), doc.layout.lang, settings.tailor);
  const coverage = words.size ? [...words].filter((word) => quoteWords.has(word)).length / words.size : 1;
  const oldWords = contentWords(String(object?.text ?? ""), doc.layout.lang, settings.tailor);
  const subset = input.action === "shorten" && [...words].every((word) => oldWords.has(word));
  if (letterBody ? !validLetter : cross || (!subset && (!validQuotes || coverage < settings.tailor.duty_min_coverage))) addClaim("duty", input.text, false, cross);
  return proposal;
}

export function derivedId(prefix: "dtx" | "itm" | "ent", proposalId: string): string {
  return `${prefix}_${proposalId.slice(4)}`;
}

function blockIdFor(doc: CareerDocument, targetId: string): string {
  for (const key of ["headline", "summary", "experience", "projects", "education", "certifications", "languages", "skills", "approach", "custom_sections"] as const) {
    const values = Array.isArray(doc[key]) ? doc[key] : [doc[key]];
    for (const entry of values) {
      if (!entry) continue;
      let found = false;
      visitProfile(entry, (object) => { if (object.id === targetId) found = true; });
      if (found) return Array.isArray(doc[key]) ? entry.id : key;
    }
  }
  return "letter";
}
