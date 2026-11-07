import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { loadContact } from "@/lib/career/contact/store";
import { renderDocumentHtml } from "@/lib/career/render/html";
import { pageBudget } from "@/lib/career/engine";
import { checkWithPdf } from "@/lib/career/render/check";
import { toResume } from "@/lib/career/render/to-resume";
import { renderPdf } from "@/lib/career/render/pdf-client";
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
    const printed = await renderPdf(rendered.html, settings.pdf, request.signal);
    if (!printed.ok) return reply({ ok: true, pages: null, budget: null, findings: [], code: printed.code });
    const projected = toResume(parsed.data.document, contact, images, parsed.data.doc);
    try {
      const checked = await checkWithPdf(projected.resume, printed.pdf, {
        doc: parsed.data.doc, today, check: settings.check, images: projected.images,
      });
      return reply({ ok: true, ...checked });
    } catch {
      const budget = pageBudget(projected.resume, parsed.data.doc, settings.check.limits);
      return reply({
        ok: true, pages: printed.pages, budget: { pages: budget, exceeded: printed.pages > budget },
        findings: [], code: "pdf_checks_failed",
      });
    }
  } catch (error) {
    logActionFailure("careerDocumentPages", error);
    return storeFailure(error);
  }
}
