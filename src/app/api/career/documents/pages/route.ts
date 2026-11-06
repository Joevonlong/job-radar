import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { loadContact } from "@/lib/career/contact/store";
import { renderDocumentHtml } from "@/lib/career/render/html";
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
    const rendered = renderDocumentHtml(parsed.data.document, {
      contact, images, doc: parsed.data.doc, today: dayInZone(new Date(), getDisplayTimeZone()),
    });
    if (!rendered.ok) return refuse("render_invalid", { issues: rendered.issues });
    const printed = await renderPdf(rendered.html, settings.pdf);
    return reply(printed.ok ? { ok: true, pages: printed.pages } : { ok: true, pages: null, code: printed.code });
  } catch (error) {
    logActionFailure("careerDocumentPages", error);
    return storeFailure(error);
  }
}
