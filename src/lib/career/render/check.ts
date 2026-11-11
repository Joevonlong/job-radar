import type { CareerConfig } from "@/lib/config/schemas/career";
import { pageBudget, plainLetter, plainResume, runCheck, runLetterCheck, shipBlockers } from "../engine";
import type { Finding, Images, Resume } from "../engine";
import { lint, placeholderIssues } from "../engine/lint";
import { letterPlaceholders, lintLetter } from "../engine/letter-check";
import { uncoveredCharacters } from "./fonts-coverage";
import { ResumeProjectionError, toResume } from "./to-resume";
import type { CareerContact } from "../schema/contact";
import type { CareerDocument } from "../schema/document";
import type { CareerImages } from "../store/images";
import type { DocumentFinding, PageCheck } from "./check-result";

type CheckOptions = {
  doc: "resume" | "letter";
  today: string;
  check: CareerConfig["check"];
  images?: Images;
};

function findings(items: Finding[]): DocumentFinding[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const finding = {
      code: item.code,
      params: item.params ?? {},
      severity: item.level,
      ...(item.where ? { path: item.where } : {}),
    };
    const key = JSON.stringify(finding);
    if (seen.has(key)) return [];
    seen.add(key);
    return [finding];
  });
}

export function checkWithoutPdf(resume: Resume, options: CheckOptions): DocumentFinding[] {
  const opts = { ...options.check, today: options.today };
  const issues = options.doc === "letter"
    ? [...lintLetter(resume, opts), ...letterPlaceholders(resume)]
    : [...lint(resume, opts), ...placeholderIssues(resume)];
  const gates = shipBlockers(resume, options.doc, opts).map((item): Finding => ({ ...item, level: "error" }));
  return findings([...issues, ...gates]);
}

export async function checkWithPdf(resume: Resume, pdf: Uint8Array, options: CheckOptions): Promise<PageCheck> {
  const opts = { ...options.check, today: options.today, images: options.images };
  const result = await (options.doc === "letter" ? runLetterCheck : runCheck)(resume, pdf, opts);
  const budget = pageBudget(resume, options.doc, options.check.limits);
  const gates = shipBlockers(resume, options.doc, { limits: opts.limits, pages: result.pages })
    .map((item): Finding => ({ ...item, level: "error" }));
  return {
    pages: result.pages,
    budget: { pages: budget, exceeded: result.pages > budget },
    findings: findings([...result.issues, ...gates]),
  };
}

export function documentExportHints(document: CareerDocument, options: {
  contact: CareerContact;
  images: CareerImages;
  today: string;
  check: CareerConfig["check"];
  scrubText?: (text: string) => string;
}): { findings: DocumentFinding[]; uncovered: string[] } {
  const allFindings: DocumentFinding[] = [];
  const uncovered = new Set<string>();
  const docs: ("resume" | "letter")[] = ["resume"];
  if (document.letter?.body.some((text) => text.included !== false && text.text.trim())) docs.push("letter");
  for (const doc of docs) {
    let resume: Resume;
    try {
      resume = toResume(document, options.contact, options.images, doc).resume;
    } catch (error) {
      if (error instanceof ResumeProjectionError) continue;
      throw error;
    }
    allFindings.push(...checkWithoutPdf(resume, { doc, today: options.today, check: options.check }));
    const plain = doc === "letter" ? plainLetter(resume, options.today) : plainResume(resume);
    const text = options.scrubText ? options.scrubText(plain) : plain;
    for (const character of uncoveredCharacters(text, options.check.uncovered_max_chars)) uncovered.add(character);
  }
  return {
    findings: allFindings.filter((finding, index) => allFindings.findIndex((item) =>
      JSON.stringify(item) === JSON.stringify(finding)) === index),
    uncovered: [...uncovered].slice(0, options.check.uncovered_max_chars),
  };
}
