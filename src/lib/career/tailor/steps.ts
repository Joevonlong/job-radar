import type { AiRouter } from "@/lib/ai/router";
import type { AiCallRecord } from "@/lib/ai/types";
import type { CareerConfig } from "@/lib/config/schemas/career";
import type { CareerTailorPayload } from "@/lib/control/types";
import type { CareerDocument } from "../schema/document";
import type { CareerProfile } from "../schema/profile";
import { pickBlocks, type TailorOutbound } from "./assemble";
import { buildCareerTailorPrompt, type TailorStep } from "./prompts";
import { proposalInputSchema, tailorOutputSchema, type Proposal } from "./proposal-schema";
import { toOutbound } from "../ai/outbound";
import { documentObjects, documentTexts } from "../document/targets";
import { verifyProposal } from "./verify";

export async function runTailorSteps(input: {
  router: AiRouter; outbound: TailorOutbound; doc: CareerDocument; profile: CareerProfile;
  payload: CareerTailorPayload; settings: CareerConfig; signal: AbortSignal; onCall: (call: AiCallRecord) => void;
}) {
  const { router, outbound, doc, profile, payload, settings, signal } = input;
  const steps: TailorStep[] = payload.mode === "shrink" ? ["shrink"] : payload.with_letter ? ["select", "rewrite", "letter"] : ["select", "rewrite"];
  const allowed = { select: ["include", "drop", "reorder"], rewrite: ["rewrite", "add"], letter: ["add", "rewrite"], shrink: ["drop", "shorten"] } as const;
  const excluded = new Set([...documentObjects(doc)].filter(([, object]) => object.included === false).map(([id]) => id));
  const objects = documentObjects(doc);
  const items: Proposal[] = [];
  let dropped = 0;
  let model: string | null = null;
  for (const step of steps) {
    signal.throwIfAborted();
    const ids = outbound.blocks.filter((block) => {
      if (step === "select") return true;
      if (step === "shrink" && block.id.startsWith("facts_")) return false;
      if (excluded.has(block.id)) return false;
      if (block.id.startsWith("facts_")) {
        const sourceId = block.id.slice(6);
        return ![...objects].some(([id, object]) => excluded.has(id) && (object.source as { entry_id?: string } | null)?.entry_id === sourceId);
      }
      return true;
    }).map((block) => block.id);
    const blocks = pickBlocks(outbound, ids);
    const ai = await router.run("career_tailor", buildCareerTailorPrompt(blocks, outbound.jd, step, { language: doc.layout.lang, overPages: payload.over_pages ?? undefined }), tailorOutputSchema, { signal, onCall: input.onCall });
    signal.throwIfAborted();
    model = ai.model ?? null;
    for (const item of ai.value.items) {
      const parsed = proposalInputSchema.safeParse(item);
      if (!parsed.success) { dropped++; continue; }
      const raw = parsed.data;
      const suggestion = { ...raw, text: raw.text === undefined ? undefined : toOutbound(raw.text), rationale: toOutbound(raw.rationale), support: raw.support.map((support) => "quote" in support ? { quote: toOutbound(support.quote) } : support) };
      const target = suggestion.target;
      const isLetter = "letter" in target || "list" in target && target.list === "letter.body"
        || "text" in target && documentTexts(doc).some((item) => item.letter && item.value.id === target.text);
      if (step === "select" && "text" in suggestion.target && ["drop", "include"].includes(suggestion.action) || step !== "shrink" && isLetter !== (step === "letter") || items.length >= settings.tailor.max_proposals) { dropped++; continue; }
      const checked = verifyProposal(suggestion, { doc, profile, pool: outbound.pool, jd: outbound.jd, settings, sentIds: ids, allowed: allowed[step] });
      if (!checked) { dropped++; continue; }
      items.push(checked);
      if (step === "select" && "entry" in checked.target) {
        if (checked.action === "drop") excluded.add(checked.target.entry);
        if (checked.action === "include") excluded.delete(checked.target.entry);
      }
    }
  }
  return { items, dropped, model };
}
