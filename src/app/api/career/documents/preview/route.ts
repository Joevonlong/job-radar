import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { loadContact } from "@/lib/career/contact/store";
import { checkWithoutPdf, documentExportHints } from "@/lib/career/render/check";
import { uncoveredCharacters } from "@/lib/career/render/fonts-coverage";
import { plainLetter, plainResume } from "@/lib/career/engine";
import { toResume } from "@/lib/career/render/to-resume";
import { renderDocumentHtml } from "@/lib/career/render/html";
import { documentSchema } from "@/lib/career/schema/document";
import { loadImages } from "@/lib/career/store/images";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { dayInZone } from "@/lib/insights/range";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readBody } from "@/lib/stories/read-body";
import { refuse, reply, storeFailure } from "../../extract/reply";

export const dynamic = "force-dynamic";
const input = z.strictObject({ document: documentSchema, doc: z.enum(["resume", "letter"]) });

export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const settings = loadConfig("career");
    const body = await readBody(request, settings.document.max_request_bytes, settings.import.upload_timeout_seconds * 1000);
    if (body === null) return refuse("too_large");
    if (body === "timeout") return refuse("invalid");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(body)); }
    catch { return refuse("invalid"); }
    const parsed = input.safeParse(raw);
    if (!parsed.success) return refuse("render_invalid", {
      issues: parsed.error.issues.map(({ path, code }) => ({ path: path.join("."), code })),
    });
    const { contact } = await loadContact();
    const images = await loadImages();
    const today = dayInZone(new Date(), getDisplayTimeZone());
    const rendered = renderDocumentHtml(parsed.data.document, {
      contact, images, doc: parsed.data.doc, today,
    });
    if (!rendered.ok) return refuse("render_invalid", { issues: rendered.issues });
    const { resume } = toResume(parsed.data.document, contact, images, parsed.data.doc);
    const findings = checkWithoutPdf(resume, { doc: parsed.data.doc, today, check: settings.check });
    const text = parsed.data.doc === "letter" ? plainLetter(resume, today) : plainResume(resume);
    const uncovered = uncoveredCharacters(text, settings.check.uncovered_max_chars);
    const exportHints = documentExportHints(parsed.data.document, { contact, images, today, check: settings.check });
    return reply({ ...rendered, findings, uncovered, exportHints });
  } catch (error) {
    logActionFailure("careerDocumentPreview", error);
    return storeFailure(error);
  }
}
