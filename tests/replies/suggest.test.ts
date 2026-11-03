import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { repliesSchema } from "@/lib/config/schemas/replies";
import { gmailFilterQuery } from "@/lib/replies/filter-query";
import { needsDecision, suggestFor } from "@/lib/replies/suggest";

const config = repliesSchema.parse(parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/defaults/replies.yaml"), "utf8")));
const AT = new Date("2026-10-01T12:00:00Z");

describe("suggestFor", () => {
  it("an interview invite on an application moves it on; from interviewing it sets the next step", () => {
    expect(suggestFor("interview_invite", "applied", config.transitions, AT)).toEqual({ kind: "status", from: "applied", to: "interviewing" });
    expect(suggestFor("interview_invite", "interviewing", config.transitions, AT).kind).toBe("next_action");
  });

  it("a rejection ends the application", () => {
    expect(suggestFor("rejection", "applied", config.transitions, AT)).toEqual({ kind: "status", from: "applied", to: "rejected" });
    expect(suggestFor("rejection", "interviewing", config.transitions, AT)).toEqual({ kind: "status", from: "interviewing", to: "rejected" });
  });

  it("a status outside the table suggests nothing; no application suggests nothing", () => {
    expect(suggestFor("offer", "rejected", config.transitions, AT).kind).toMatch(/none|mismatch/);
    expect(suggestFor("rejection", null, config.transitions, AT)).toEqual({ kind: "none" });
    expect(suggestFor("other", "applied", config.transitions, AT)).toEqual({ kind: "none" });
    expect(suggestFor("unclassified", "applied", config.transitions, AT)).toEqual({ kind: "none" });
  });

  it("a request for materials has a due date counted from the mail", () => {
    const suggestion = suggestFor("info_request", "applied", config.transitions, AT);
    expect(suggestion.kind).toBe("next_action");
    if (suggestion.kind === "next_action") expect(suggestion.due).toMatch(/^2026-10-\d\d$/);
  });
});

describe("the transition table", () => {
  const S = (to: string) => `-> ${to}`;
  const cases: Record<string, Record<string, string>> = {
    interview_invite: { interested: "none", preparing: S("interviewing"), applied: S("interviewing"), interviewing: "next_action", offer: "none" },
    rejection: { interested: "none", preparing: "mismatch", applied: S("rejected"), interviewing: S("rejected"), offer: S("rejected") },
    offer: { interested: "none", preparing: "none", applied: S("offer"), interviewing: S("offer"), offer: "none" },
    info_request: { interested: "next_action", preparing: "next_action", applied: "next_action", interviewing: "next_action", offer: "next_action" },
    acknowledgement: { interested: S("applied"), preparing: S("applied"), applied: "none", interviewing: "none", offer: "none" },
  };
  const rows = Object.entries(cases).flatMap(([category, byStatus]) => Object.entries(byStatus).map(([status, expected]) => [category, status, expected] as const));

  it.each(rows)("%s on %s: %s", (category, status, expected) => {
    const suggestion = suggestFor(category as never, status as never, config.transitions, AT);
    expect(suggestion.kind === "status" ? S(suggestion.to) : suggestion.kind).toBe(expected);
  });

  it.each(["rejected", "withdrawn", "archived", "new"])("%s never gets a suggestion", (status) => {
    for (const category of Object.keys(cases)) expect(suggestFor(category as never, status as never, config.transitions, AT)).toEqual({ kind: "none" });
  });
});

describe("needsDecision", () => {
  const status = { kind: "status", from: "applied", to: "rejected" } as const;
  it("what can be decided waits; a record does not", () => {
    expect(needsDecision({ category: "rejection", match: "matched", suggestion: status })).toBe(true);
    expect(needsDecision({ category: "acknowledgement", match: "matched", suggestion: { kind: "none" } })).toBe(false);
    expect(needsDecision({ category: "other", match: "unmatched", suggestion: { kind: "none" } })).toBe(false);
  });
  it("unclassified or unlinked mail waits for the user", () => {
    expect(needsDecision({ category: "unclassified", match: "matched", suggestion: { kind: "none" } })).toBe(true);
    expect(needsDecision({ category: "rejection", match: "ambiguous", suggestion: { kind: "none" } })).toBe(true);
    expect(needsDecision({ category: "rejection", match: "unmatched", suggestion: { kind: "none" } })).toBe(true);
  });
});

describe("gmailFilterQuery", () => {
  it("lists ATS senders, own hosts and company names, without generic hosts", () => {
    const query = gmailFilterQuery({ companies: ['Acme "Robotics"'], hosts: ["www.acme.example", "gmail.com"] }, { ats_sender_domains: ["ats.example"], generic_domains: ["gmail.com"] });
    expect(query).toBe('from:(acme.example OR ats.example) OR subject:("Acme Robotics")');
  });
});
