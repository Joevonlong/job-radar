import { expect, expectTypeOf, it } from "vitest";
import { buildStoryExtractPrompt } from "@/lib/ai/prompts/story-extract";
import { confirmedOutbound, NO_STORED_VALUES, type OutboundText } from "@/lib/outbound/outbound";

it("requires outbound text and preserves every confirmed character", () => {
  expectTypeOf<Parameters<typeof buildStoryExtractPrompt>[0]["text"]>().toEqualTypeOf<OutboundText>();
  expectTypeOf<string>().not.toExtend<OutboundText>();
  const text = confirmedOutbound("  Built reliable services.\n", NO_STORED_VALUES);
  expect(buildStoryExtractPrompt({ text, maxDrafts: 3, quoteMaxChars: 80 }).user).toBe(`<story_source>\n${text}\n</story_source>`);
});
