import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import fs from "node:fs";
import path from "node:path";

import { repliesSchema, type RepliesConfig } from "@/lib/config/schemas/replies";
import { classifyReply, quoteOf } from "@/lib/replies/classify";

import { REPLY_CASES } from "../fixtures/replies/cases";

let config: RepliesConfig;
beforeAll(() => {
  config = repliesSchema.parse(parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/defaults/replies.yaml"), "utf8")));
});

describe("classifyReply", () => {
  it.each(REPLY_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(classifyReply({ subject: c.subject, body: c.body }, config.categories, 200).category).toBe(c.expected);
  });

  it("gives the sentence that decided as evidence", () => {
    const body = "Dear applicant. Unfortunately we chose someone else. Good luck!";
    const { evidence } = classifyReply({ subject: "Your application", body }, config.categories, 200);
    expect(evidence).toContain("Unfortunately we chose someone else");
    expect(evidence).not.toContain("Good luck");
  });

  it("two categories at once stay unclassified", () => {
    const body = "We would like to invite you to an interview. We regret to inform you that the position has been filled.";
    expect(classifyReply({ subject: "x", body }, config.categories, 200).category).toBe("unclassified");
  });
});

describe("quoteOf", () => {
  it("falls back to the first line and cuts to the limit", () => {
    expect(quoteOf(null, "\n\nFirst line here\nsecond", 200)).toBe("First line here");
    expect(quoteOf("a".repeat(50), "", 10)).toHaveLength(10);
    expect(quoteOf(null, "", 10)).toBeNull();
  });
});
