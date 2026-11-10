import { afterEach, expect, test } from "vitest";
import { createAiRouter } from "@/lib/ai/router";
import { runTailorSteps } from "@/lib/career/tailor/steps";
import { assembleOutbound } from "@/lib/career/tailor/assemble";
import { preferencesSchema } from "@/lib/career/schema/preferences";
import { careerTailorPayloadSchema } from "@/lib/control/types";
import { tempCareer } from "./fixtures";
import { tailorFixture } from "./tailor-fixtures";
import { pinnedAi, scriptedProvider } from "../ai/helpers";

let temp: ReturnType<typeof tempCareer>;
afterEach(() => temp?.cleanup());
test.each([false, true])("steps send only confirmed blocks and call letter only when requested: %s", async (withLetter) => {
  temp = tempCareer(); const context = tailorFixture();
  const entry = context.doc.experience[0]!.id;
  const scripted = scriptedProvider("codex-cli", [
    JSON.stringify({ items: [{ action: "drop", target: { entry }, rationale: "MODEL_ONLY_SENTINEL" }] }),
    JSON.stringify({ items: [{ action: "rewrite", target: { text: context.text.id }, text: "Reduced batch time" }] }),
    JSON.stringify({ items: [{ action: "add", target: { list: "letter.body" }, text: "I enjoy building useful services" }] }),
  ]);
  const preferences = preferencesSchema.parse({ schema_version: 1, layout: context.settings.document.defaults, emphasis: null, tone: null });
  const outbound = assembleOutbound({ ...context, job: null, preferences, mode: "tailor" });
  const payload = careerTailorPayloadSchema.parse({ doc_id: context.doc.id, mode: "tailor", with_letter: withLetter, outbound_hash: outbound.hash });
  const result = await runTailorSteps({ ...context, outbound, payload, router: createAiRouter({ config: pinnedAi(), providers: [scripted.provider], usage: null }), signal: new AbortController().signal, onCall: () => {} });
  expect(scripted.transport.calls).toHaveLength(withLetter ? 3 : 2);
  expect(result.dropped).toBe(1);
  for (const call of scripted.transport.calls) {
    expect(call.user).not.toContain("MODEL_ONLY_SENTINEL");
    for (const block of call.user.matchAll(/<career_block id="([^"]+)">\n([\s\S]*?)\n<\/career_block>/g)) expect(outbound.blocks).toContainEqual({ id: block[1], text: block[2] });
  }
  expect(scripted.transport.calls[1]!.user).not.toContain(entry);
  expect(result.items.filter((item) => "list" in item.target && item.target.list === "letter.body")).toHaveLength(withLetter ? 1 : 0);
});

test("shrink drops prohibited actions and preserves supported shortening", async () => {
  temp = tempCareer(); const context = tailorFixture();
  const scripted = scriptedProvider("codex-cli", [JSON.stringify({ items: [
    { action: "shorten", target: { text: context.text.id }, text: "Reduced batch time" },
    { action: "rewrite", target: { text: context.text.id }, text: "New duty" },
    { action: "mutate", target: { text: context.text.id }, text: "Invalid action" },
  ] })]);
  const outbound = assembleOutbound({ ...context, job: null, preferences: preferencesSchema.parse({ schema_version: 1, layout: context.settings.document.defaults, emphasis: null, tone: null }), mode: "shrink" });
  const payload = careerTailorPayloadSchema.parse({ doc_id: context.doc.id, mode: "shrink", over_pages: 1, outbound_hash: outbound.hash });
  const result = await runTailorSteps({ ...context, outbound, payload, router: createAiRouter({ config: pinnedAi(), providers: [scripted.provider], usage: null }), signal: new AbortController().signal, onCall: () => {} });
  expect(result.dropped).toBe(2); expect(result.items).toHaveLength(1);
  expect(result.items[0]!.claims).toEqual([]);
  expect(scripted.transport.calls).toHaveLength(1);
  expect(scripted.transport.calls[0]!.user).not.toContain("facts_");
});
