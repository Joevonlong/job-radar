// @vitest-environment node
import { describe, expect, it } from "vitest";

import { companiesSchema } from "@/lib/config";
import type { BoardCandidateRow } from "@/lib/db";
import { candidateKeySchema, candidateName, toCandidateViews } from "@/lib/sources/candidates";

const companies = companiesSchema.parse({
  companies: [{ name: "Known", ats: "ashby", token: "KnownCo", enabled: false }],
});

function row(extra: Partial<BoardCandidateRow>): BoardCandidateRow {
  return {
    id: 1,
    ats: "ashby",
    token: "acme-labs",
    region: null,
    boardUrl: "https://jobs.ashbyhq.com/acme-labs",
    title: "AI Engineer - Acme Labs",
    status: "new",
    seenCount: 2,
    firstSeenAt: new Date("2026-10-01T10:00:00Z"),
    lastSeenAt: new Date("2026-10-06T10:00:00Z"),
    ...extra,
  };
}

describe("candidateName", () => {
  it("title-cases a lower-case slug and leaves a token with capitals alone", () => {
    expect(candidateName("acme-labs")).toBe("Acme Labs");
    expect(candidateName("nerven_robotics")).toBe("Nerven Robotics");
    expect(candidateName("tiefwort")).toBe("Tiefwort");
    expect(candidateName("BergwerkGroup")).toBe("BergwerkGroup");
  });
});

describe("toCandidateViews", () => {
  it("lists new candidates only, and not boards that companies.yaml has by now (any case, any enabled state)", () => {
    const views = toCandidateViews(
      [
        row({}),
        row({ id: 2, token: "knownco" }),
        row({ id: 3, token: "done", status: "added" }),
        row({ id: 4, token: "nope", status: "dismissed" }),
        row({ id: 5, ats: "workday", token: "foreign" }),
        row({ id: 6, ats: "lever", token: "euboard", region: "eu", title: null }),
      ],
      companies,
    );
    expect(views.map((v) => `${v.ats}:${v.token}`)).toEqual(["ashby:acme-labs", "lever:euboard"]);
    expect(views[0]).toMatchObject({ name: "Acme Labs", region: null, seenCount: 2, title: "AI Engineer - Acme Labs" });
    expect(views[1]).toMatchObject({ region: "eu", title: null });
  });
});

describe("candidateKeySchema", () => {
  it("accepts a known ats and a plain token only", () => {
    expect(candidateKeySchema.safeParse({ ats: "personio", token: "nerven-robotics" }).success).toBe(true);
    for (const bad of [
      { ats: "workday", token: "x" },
      { ats: "lever", token: "../x" },
      { ats: "lever", token: "" },
      { ats: "lever", token: "x", extra: 1 },
      { ats: "lever" },
      null,
    ]) {
      expect(candidateKeySchema.safeParse(bad).success).toBe(false);
    }
  });
});
