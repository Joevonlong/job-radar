import type { CareerConfig } from "@/lib/config/schemas/career";
import { pageBudget, plainLetter, plainResume } from "../engine";
import type { CareerContact } from "../schema/contact";
import type { CareerDocument } from "../schema/document";
import type { CareerImages } from "../store/images";
import { checkWithoutPdf, documentExportHints } from "./check";
import { uncoveredCharacters } from "./fonts-coverage";
import { renderDocumentHtml } from "./html";
import { toResume } from "./to-resume";

export function previewDocument(document: CareerDocument, options: {
  contact: CareerContact;
  images: CareerImages;
  doc: "resume" | "letter";
  today: string;
  check: CareerConfig["check"];
  scrubText?: (text: string) => string;
}) {
  const rendered = renderDocumentHtml(document, options);
  if (!rendered.ok) return rendered;
  const { resume } = toResume(document, options.contact, options.images, options.doc);
  const findings = checkWithoutPdf(resume, options);
  const plain = options.doc === "letter" ? plainLetter(resume, options.today) : plainResume(resume);
  const text = options.scrubText ? options.scrubText(plain) : plain;
  const uncovered = uncoveredCharacters(text, options.check.uncovered_max_chars);
  const exportHints = documentExportHints(document, options);
  return {
    ...rendered,
    findings,
    uncovered,
    exportHints,
    text,
    pageBudget: { pages: pageBudget(resume, options.doc, options.check.limits) },
  };
}
