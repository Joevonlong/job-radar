// @vitest-environment node
import { expect, it } from "vitest";
import { readPrepareInput } from "@/lib/outbound/prepare";
import { prepareScrub } from "@/lib/outbound/scrub";
import { NO_STORED_VALUES } from "@/lib/outbound/outbound";
import { careerSchema } from "@/lib/config/schemas/career";
import { multiPagePdf } from "../fixtures/pdf";

it("reports unread PDF pages even when scrubbing brings the preview below its limit", async () => {
  const limits = { ...careerSchema.parse({}).import, min_chars: 1, max_chars: 45 };
  const firstPage = "long-private-address@fictional-domain.invalid";
  const form = new FormData();
  const pdf = new Uint8Array(multiPagePdf([[firstPage, firstPage], ["Unread second page"]]));
  form.set("file", new File([pdf], "resume.pdf"));
  const read = await readPrepareInput(new Request("http://localhost/prepare", { method: "POST", body: form }), limits);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(read.error);
  expect(read.input.text).not.toContain("Unread second page");
  const preview = prepareScrub(read.input.text, { ...read.input, stored: NO_STORED_VALUES, rules: limits });
  expect(preview.text.length).toBeLessThan(limits.max_chars);
  expect(preview.text).not.toContain(firstPage);
  expect(preview.truncated).toBe(true);
});
