import { redactDocument } from "@/lib/career/document/redact";
import { sourceStates } from "@/lib/career/document/resolve";
import { listDocumentVersions, loadDocument } from "@/lib/career/store/documents";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { readProposals } from "@/lib/career/tailor/proposals";
import { getJob } from "@/lib/db/repos/jobs";
import { getCareerDocumentOutput } from "@/lib/mcp/dto/career";
import { loadJobQuoteGuard } from "@/lib/mcp/tools/shared";
import { descriptionHash } from "@/lib/translation/hash";
import { defineCapability, READ_ONLY } from "../types";
import { careerAvailability, careerCleaner, careerRead, documentInput, storedDocument } from "./shared";

export const get_career_document = defineCapability({
  id: "get_career_document",
  kind: "read",
  permission: "career:read",
  input: documentInput,
  output: getCareerDocumentOutput,
  handler: (ctx, args) => careerRead(ctx, async () => {
    const scrub = careerCleaner(ctx);
    const { document, baseHash } = await storedDocument(args);
    const profile = await loadCareerProfile();
    const job = document.job ? await getJob(ctx.db, document.job.id) : null;
    const guard = await loadJobQuoteGuard(ctx, document.job ? [document.job.id] : []);
    const stored = await readProposals(args.id).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
    const currentHash = baseHash ?? await loadDocument(args.id).then((current) => current.baseHash, () => null);
    const proposals = !stored.ok
      ? { status: "unavailable" as const, stale: null, items: [] }
      : stored.value === null ? null : {
        status: "ok" as const,
        stale: stored.value.doc_hash !== currentHash,
        items: stored.value.items.map((item) => ({
          ...item,
          target: Object.fromEntries(Object.entries(item.target).map(([key, value]) => [key, scrub(value)])),
          ...(item.text === undefined ? {} : { text: scrub(item.text) }),
          ...(item.after === undefined ? {} : { after: item.after === null ? null : scrub(item.after) }),
          ...(item.order === undefined ? {} : { order: item.order.map(scrub) }),
          rationale: scrub(item.rationale),
          claims: item.claims.map((claim) => ({
            ...claim,
            text: scrub(claim.text),
            target: "entry" in claim.target ? {
              ...claim.target, field: scrub(claim.target.field), value: scrub(claim.target.value),
            } : claim.target,
          })),
          support: item.support.map((support) => {
            if ("entry" in support) return { entry: scrub(support.entry) };
            const quote = document.job ? guard(document.job.id, support.quote) : null;
            return { quote: quote === null ? null : scrub(quote) };
          }),
        })),
      };
    return getCareerDocumentOutput.parse({
      notices: [ctx.text("notice.thirdParty")],
      document: redactDocument(document, scrub),
      baseHash,
      versions: await listDocumentVersions(args.id),
      version: args.version ?? null,
      source: {
        jdChanged: document.job && job?.description != null ? document.job.jd_hash !== descriptionHash(job.description) : null,
        profileChanged: document.profile_hash === null ? null : sourceStates(document, profile.profile, profile.baseHash).profileChanged,
      },
      proposals,
    });
  }),
  count: () => 1,
  annotations: READ_ONLY,
  availability: careerAvailability,
  text: { title: "tools.get_career_document.title", description: "tools.get_career_document.description" },
});
