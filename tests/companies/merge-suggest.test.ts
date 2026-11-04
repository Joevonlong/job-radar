import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { failureText, parsePlanText } from "@/lib/companies/merge-run";
import { suggestCompanyMerges, type MergeSuggestRow } from "@/lib/companies/merge-suggest";
import { normalizeCompanyKey } from "@/lib/pipeline/company";

import { pipelineWith } from "../pipeline/helpers";

const pipeline = pipelineWith((raw) => {
  raw.company = { ...(raw.company as object), aliases: {}, duplicate_tail_words: ["Germany", "deutschland", "group", "global", "software", "services", "consulting", "labs", "technologies"] };
});

let nextId = 1;
function row(name: string, jobCount = 1, over: Partial<MergeSuggestRow> = {}): MergeSuggestRow {
  return { id: nextId++, name, nameNorm: normalizeCompanyKey(name, pipeline.company.legal_suffixes), aliases: [], watched: false, blacklisted: false, jobCount, ...over };
}
const pairsOf = (rows: MergeSuggestRow[], tier: 1 | 2) =>
  suggestCompanyMerges(rows, pipeline)
    .filter((suggestion) => suggestion.tier === tier)
    .map((suggestion) => [suggestion.into.name, ...suggestion.from.map((other) => other.name)]);

describe("suggestCompanyMerges", () => {
  it.each([
    ["Aleph Alpha", "Alephalpha"],
    ["Veeam Software", "veeamsoftware"],
    ["Neural Concept", "Neuralconcept"],
    ["Legal Hero GmbH", "Legalhero"],
    ["Mirakl - Labs", "mirakllabs"],
    ["WE BUILD AI", "WEBUILDAI GmbH"],
    ["Orcrist Technologies GmbH", "orcristtechnologies"],
    ["Think Cell", "thinkcell"],
    ["Immo Sandbox GmbH", "Immosandbox GmbH"],
  ])("puts the spellings %s / %s in tier 1", (kept, other) => {
    expect(pairsOf([row(other, 1), row(kept, 4)], 1)).toEqual([[kept, other]]);
  });

  it("finds rows that share a stored alias key in tier 1", () => {
    expect(pairsOf([row("Acme", 2), row("Acme Holdco", 1, { aliases: ["ACME GmbH"] })], 1)).toEqual([["Acme", "Acme Holdco"]]);
  });

  it("finds rows the configured aliases join in tier 1", () => {
    const aliased = pipelineWith((raw) => {
      raw.company = { ...(raw.company as object), aliases: { Acme: ["Acme Old Name"] } };
    });
    const rows = [row("Acme", 2), row("Acme Old Name", 1)];
    expect(suggestCompanyMerges(rows, aliased).map((suggestion) => [suggestion.tier, suggestion.into.name])).toContainEqual([1, "Acme"]);
  });

  it("offers parent and subsidiary names only in tier 2", () => {
    const rows = [row("Allianz", 9), row("Allianz Services", 3), row("Allianz Deutschland AG", 2), row("Infosys", 2), row("Infosys Consulting", 1)];
    expect(pairsOf(rows, 1)).toEqual([]);
    expect(pairsOf(rows, 2)).toEqual([
      ["Allianz", "Allianz Services", "Allianz Deutschland AG"],
      ["Infosys", "Infosys Consulting"],
    ]);
  });

  it("compares the main part of a name in tier 2", () => {
    expect(pairsOf([row("Boston Consulting Group", 3), row("Boston Consulting Group (BCG)", 1)], 2)).toEqual([["Boston Consulting Group", "Boston Consulting Group (BCG)"]]);
    expect(pairsOf([row("Acme | Berlin", 3), row("Acme – Munich", 1)], 2)).toEqual([["Acme | Berlin", "Acme – Munich"]]);
  });

  it("does not offer names that only look alike", () => {
    const rows = [row("JUNI"), row("junini"), row("develop"), row("DevelopX"), row("Fraunhofer IIS"), row("Fraunhofer IISB"), row("Deutsche Telekom"), row("Deutsche Telekom IoT")];
    expect(suggestCompanyMerges(rows, pipeline)).toEqual([]);
  });

  it("does not list a row tier 1 already folds again in tier 2", () => {
    const rows = [row("Veeam", 9), row("Veeam Software", 3), row("veeamsoftware", 1)];
    expect(pairsOf(rows, 1)).toEqual([["Veeam Software", "veeamsoftware"]]);
    expect(pairsOf(rows, 2)).toEqual([["Veeam", "Veeam Software"]]);
  });

  describe("which row stays", () => {
    const keeps = (...rows: MergeSuggestRow[]) => suggestCompanyMerges(rows, pipeline)[0]?.into.name;

    it("not the token spelling, even with more jobs", () => {
      expect(keeps(row("thinkcell", 50), row("Think Cell", 1))).toBe("Think Cell");
    });
    it("a marked row before one with more jobs", () => {
      expect(keeps(row("Aleph Alpha", 50), row("Alephalpha", 1, { watched: true }))).toBe("Alephalpha");
      expect(keeps(row("Aleph Alpha", 50), row("Alephalpha", 1, { blacklisted: true }))).toBe("Alephalpha");
    });
    it("in tier 1, the spelling with word breaks before the one with more jobs", () => {
      expect(keeps(row("Alephalpha", 4), row("Aleph Alpha", 3))).toBe("Aleph Alpha");
      expect(keeps(row("Agilerobotsse", 7), row("Agile Robots SE", 6, { nameNorm: "agile-robots-se" }))).toBe("Agile Robots SE");
    });
    it("then more jobs, then the older id", () => {
      expect(keeps(row("Acme-Works", 2), row("Acme Works", 3))).toBe("Acme Works");
      expect(keeps(row("Acme-Works", 3), row("Acme Works", 3))).toBe("Acme-Works");
    });
    it("a name that only has fewer words is no slug", () => {
      expect(keeps(row("Acme", 3), row("Acme Holdco", 1, { aliases: ["ACME GmbH"] }))).toBe("Acme");
    });
    it("in tier 2, more jobs however many words a name has", () => {
      expect(keeps(row("Allianz Services", 1), row("Allianz", 3))).toBe("Allianz");
      expect(keeps(row("Allianz Services", 3), row("Allianz", 1))).toBe("Allianz Services");
    });
  });
});

describe("failureText", () => {
  it("gives the cause of a failed query, not the query and its parameters", () => {
    const error = new Error('Failed query: insert into "company_merges" values ($1)\nparams: Acme', { cause: new Error("connection lost") });
    expect(failureText(error)).toBe("connection lost");
  });
  it("gives the message of any other error, on one line", () => {
    expect(failureText(new Error("bad\nrecord"))).toBe("bad record");
    expect(failureText("text")).toBe("text");
  });
  it("names an error that has no message", () => {
    expect(failureText(new Error("", { cause: new TypeError("") }))).toBe("TypeError");
  });
});

describe("the companies:merge script", () => {
  it("reports an unreachable database without the failed query, and exits 1", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/companies-merge.ts", "--list"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgres://nobody:secret@127.0.0.1:1/none" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("companies:merge: ");
    expect(run.stderr).not.toContain("Failed query");
    expect(run.stderr).not.toContain("params:");
  }, 60_000);
});

describe("parsePlanText", () => {
  it("reads pairs, comments and blank lines", () => {
    expect(parsePlanText("# a comment\n\n12 34  # A -> B\r\n 5\t6\n")).toEqual({ ok: true, pairs: [{ fromId: 12, intoId: 34 }, { fromId: 5, intoId: 6 }] });
  });
  it.each(["1", "1 2 3", "a b", "1 -2", "0 1", "1e3 2", "99999999999999999 1"])("names the line of the bad entry %s", (text) => {
    expect(parsePlanText(`1 2\n${text}\n`)).toEqual({ ok: false, line: 2, text });
  });
});
