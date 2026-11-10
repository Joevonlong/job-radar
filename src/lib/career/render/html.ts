import type { CareerContact } from "../schema/contact";
import type { CareerDocument } from "../schema/document";
import type { CareerImages } from "../store/images";
import { CareerEngineError } from "../engine/errors";
import { renderResume } from "../engine/render";
import { ResumeProjectionError, toResume, type ProjectionIssue } from "./to-resume";

export function renderDocumentHtml(document: CareerDocument, options: {
  contact: CareerContact; images: CareerImages; doc: "resume" | "letter"; today: string;
}): { ok: true; html: string } | { ok: false; issues: ProjectionIssue[] } {
  try {
    const projected = toResume(document, options.contact, options.images, options.doc);
    return { ok: true, html: renderResume(projected.resume, { images: projected.images, doc: options.doc, today: options.today }) };
  } catch (error) {
    if (error instanceof ResumeProjectionError) return { ok: false, issues: error.issues };
    if (error instanceof CareerEngineError) return { ok: false, issues: [{ path: "", code: error.code }] };
    throw error;
  }
}
