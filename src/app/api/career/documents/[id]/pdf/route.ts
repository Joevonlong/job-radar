import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { loadContact } from "@/lib/career/contact/store";
import { contentDisposition, exportStem } from "@/lib/career/engine/naming";
import { renderDocumentHtml } from "@/lib/career/render/html";
import { renderPdf } from "@/lib/career/render/pdf-client";
import { toResume } from "@/lib/career/render/to-resume";
import { documentIdSchema } from "@/lib/career/schema/document";
import { loadDocument } from "@/lib/career/store/documents";
import { loadImages } from "@/lib/career/store/images";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { dayInZone } from "@/lib/insights/range";
import { logActionFailure } from "@/lib/logging/action-failure";
import { refuse, storeFailure } from "../../../extract/reply";

export const dynamic = "force-dynamic";
const querySchema = z.strictObject({ doc: z.enum(["resume", "letter"]) });
const paramsSchema = z.strictObject({ id: documentIdSchema });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const params = paramsSchema.safeParse(await context.params);
    const search = new URL(request.url).searchParams;
    const query = querySchema.safeParse(Object.fromEntries(search));
    if (!params.success || !query.success || [...search.keys()].length !== 1) return refuse("invalid");
    const { document } = await loadDocument(params.data.id);
    const doc = query.data.doc;
    if (doc === "letter" && !document.letter?.body.some((entry) => entry.included !== false && entry.text.trim())) {
      return refuse("letter_missing");
    }
    const settings = loadConfig("career");
    const { contact } = await loadContact();
    const images = await loadImages();
    const today = dayInZone(new Date(), getDisplayTimeZone());
    const rendered = renderDocumentHtml(document, { contact, images, doc, today });
    if (!rendered.ok) return refuse("render_invalid", { issues: rendered.issues });
    const printed = await renderPdf(rendered.html, settings.pdf, request.signal);
    if (!printed.ok) return refuse(printed.code);
    const { resume } = toResume(document, contact, images, doc);
    const filename = `${exportStem(resume, today, doc)}.pdf`;
    return new Response(printed.pdf, { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": contentDisposition(filename), "Cache-Control": "no-store",
    } });
  } catch (error) {
    logActionFailure("careerDocumentPdf", error);
    return storeFailure(error);
  }
}
