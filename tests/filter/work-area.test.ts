// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { compileFilter, evaluateJob } from "@/lib/filter";
import { compileWorkArea, readWorkArea, type CompiledWorkArea } from "@/lib/filter/work-area";
import { buildEffectivePipeline } from "@/lib/market/effective";
import { readPackDir } from "@/lib/market/load";
import { placeGeo } from "@/lib/market/places";
import type { WorkAreaPhrases } from "@/lib/market/schema";
import { resolveMarket } from "@/lib/market/resolve";

import { job, loc, prefs } from "./helpers";
import { shippedPipelineFile } from "../pipeline/helpers";

const LABELLED = parse(fs.readFileSync(path.join(import.meta.dirname, "../fixtures/work-area/labelled.yaml"), "utf8")) as Record<string, [string, string][]>;
/** The phrases being measured are the shipped ones, so this reads the repository's packs, not the fixture's. It holds them to a hit rate and asserts no value of theirs. */
const shippedPack = (id: string) => readPackDir(id, path.join(import.meta.dirname, "../../config/packs", id), "shipped");
const pipeline = buildEffectivePipeline(shippedPipelineFile(), resolveMarket({ pack: "de" }, shippedPack), shippedPack);
const geo = placeGeo(pipeline, null);
const phrases: WorkAreaPhrases = pipeline.filter.remote.work_area;
const area = compileWorkArea(phrases);

/** What a label says, in the reader's terms. */
function expected(label: string): string {
  if (label === "none") return "not sure";
  if (label === "worldwide") return "anywhere";
  const region = geo.regions[label];
  return (region ? [...region.countries] : label.split(",")).sort().join(",");
}

type Where = "description" | "title";

function read(text: string, where: Where, using: CompiledWorkArea = area): string {
  const reading = where === "title" ? readWorkArea(text, null, using, geo) : readWorkArea("Engineer", text, using, geo);
  if (!reading.sure) return "not sure";
  return reading.countries === null ? "anywhere" : [...reading.countries].sort().join(",");
}

const WHOLE_SET = Object.values(LABELLED).flat();
/** These groups are sentences of a description. */
const ABOUT_SOMETHING_ELSE = ["not_about_the_job", "not_about_the_job_de", "not_about_the_job_more"];
const TITLES = Object.entries(LABELLED).flatMap(([group, sentences]) => (ABOUT_SOMETHING_ELSE.includes(group) ? [] : sentences));
const allowedWrong = (sure: number): number => Math.floor(sure * 0.05);
const wrongOf = (sentences: [string, string][], where: Where, using: CompiledWorkArea = area): string[] =>
  sentences.filter(([text, label]) => read(text, where, using) !== "not sure" && read(text, where, using) !== expected(label)).map(([text]) => `${text} => ${read(text, where, using)}`);
const readOf = (sentences: [string, string][], where: Where, using: CompiledWorkArea = area): number => sentences.filter(([text]) => read(text, where, using) !== "not sure").length;

describe("the phrases on labelled made-up sentences", () => {
  describe.each<Where>(["description", "title"])("read as the %s", (where) => {
    it.each(Object.keys(LABELLED).filter((group) => where === "description" || !ABOUT_SOMETHING_ELSE.includes(group)))("%s: what is read is right at least 95% of the time", (group) => {
      const sentences = LABELLED[group] ?? [];
      const wrong = wrongOf(sentences, where);
      expect(wrong.length, wrong.join(" | ")).toBeLessThanOrEqual(allowedWrong(readOf(sentences, where)));
    });
  });

  it.each(ABOUT_SOMETHING_ELSE)("%s: a sentence about something else in a description never decides anything", (group) => {
    const decided = (LABELLED[group] ?? []).filter(([text]) => read(text, "description") !== "not sure").map(([text]) => `${text} => ${read(text, "description")}`);
    expect(decided).toEqual([]);
  });

  it("reads over half of what can be read", () => {
    const readable = WHOLE_SET.filter(([, label]) => label !== "none");
    expect(readOf(readable, "description") / readable.length).toBeGreaterThan(0.5);
  });

  const onlyOne = (patterns: Partial<WorkAreaPhrases>) => compileWorkArea({ ...phrases, patterns: [], title_patterns: [], anywhere: [], ...patterns });
  it.each(phrases.patterns)("description phrase %s: is measured, and right at least 95% of the time", (pattern) => {
    const one = onlyOne({ patterns: [pattern] });
    expect(readOf(WHOLE_SET, "description", one)).toBeGreaterThanOrEqual(5);
    expect(wrongOf(WHOLE_SET, "description", one).length).toBeLessThanOrEqual(allowedWrong(readOf(WHOLE_SET, "description", one)));
  });
  it.each(phrases.title_patterns)("title phrase %s: is measured, and right at least 95% of the time", (pattern) => {
    const one = onlyOne({ title_patterns: [pattern] });
    expect(readOf(TITLES, "title", one)).toBeGreaterThanOrEqual(5);
    expect(wrongOf(TITLES, "title", one).length).toBeLessThanOrEqual(allowedWrong(readOf(TITLES, "title", one)));
  });
  it.each(phrases.anywhere)("anywhere phrase %s: is measured, and right at least 95% of the time", (pattern) => {
    const one = onlyOne({ anywhere: [pattern] });
    expect(readOf(WHOLE_SET, "description", one)).toBeGreaterThanOrEqual(5);
    expect(wrongOf(WHOLE_SET, "description", one).length).toBeLessThanOrEqual(allowedWrong(readOf(WHOLE_SET, "description", one)));
  });
});

describe("the phrases on a remote job", () => {
  const verdict = (places: { place: string; relocate: boolean }[], title: string, description: string) => {
    const preferences = prefs((raw) => {
      raw.home_city = "Hamburg";
      raw.places = places;
      raw.workplace = ["remote"];
    });
    return evaluateJob(job({ workplace: "remote", title, description, locations: [loc("Germany", null, "DE")] }), compileFilter(preferences, pipeline, { me: null, watchedCompanies: [] }));
  };

  it("hides on a clear statement of somewhere I can't take the job", () => {
    expect(verdict([], "Engineer", "US residents only.").result).toBe("filtered_out");
    expect(verdict([{ place: "FI", relocate: false }], "Engineer", "You must live in Finland.").result).toBe("filtered_out");
    expect(verdict([], "Engineer (France only)", "").reasons).toEqual(["remote_out_of_scope:France only"]);
  });

  it("passes on a statement that covers me", () => {
    expect(verdict([], "Engineer (EU only)", "").result).toBe("passed");
    expect(verdict([{ place: "FI", relocate: true }], "Engineer", "You must live in Finland.").reasons).not.toContain("remote_area_unknown");
  });

  it("keeps a benefit line, with the note", () => {
    expect(verdict([], "Engineer", "Private medical cover (UK only)")).toEqual({ result: "passed", reasons: expect.arrayContaining(["remote_area_unknown"]) });
  });
});

describe("readWorkArea", () => {
  const description = (text: string) => readWorkArea("Engineer", text, area, geo);

  it("is not sure about a bare place, a negation, a place the tables do not know, or mixed signals", () => {
    expect(description("Our office is in Germany.").sure).toBe(false);
    expect(description("You do not need to live in Germany.").sure).toBe(false);
    expect(description("You must live in Smalltown.").sure).toBe(false);
    expect(description("You must live in Germany or Smalltown.").sure).toBe(false);
    expect(description("You must live in Germany. You must live in France.").sure).toBe(false);
    expect(description("Work from anywhere. You must live in France.").sure).toBe(false);
    expect(readWorkArea("Engineer", null, area, geo).sure).toBe(false);
  });

  it("is not sure about a bare code or a short name in lower case", () => {
    expect(description("You must live in FR.").sure).toBe(false);
    expect(description("You must live in us.").sure).toBe(false);
    expect(description("You must live in the US.")).toMatchObject({ sure: true, countries: ["US"] });
    expect(description("You must be based in the U.S.")).toMatchObject({ sure: true, countries: ["US"] });
  });

  it("is not sure when the list may carry on", () => {
    expect(description("You must live in France to apply, or in Germany.").sure).toBe(false);
    expect(description("You must live in France (or Spain).").sure).toBe(false);
    expect(description("You must live in France to apply.")).toMatchObject({ sure: true, countries: ["FR"] });
    expect(description("You must live in France\nor Germany").sure).toBe(false);
    expect(description("Open to candidates in France\n- Germany\n- Spain").sure).toBe(false);
    expect(description("Open to candidates in France\nGermany\nSpain").sure).toBe(false);
    expect(description("You must live in France\nThe team is small.")).toMatchObject({ sure: true, countries: ["FR"] });
  });

  it("reads a question as no statement", () => {
    expect(description("Remote? You must live in France.")).toMatchObject({ sure: true, countries: ["FR"] });
    expect(description("Can you work from anywhere? You must live in France.")).toMatchObject({ sure: true, countries: ["FR"] });
    expect(description("You must live in France?").sure).toBe(false);
  });

  it("reads a phrase of the title in the title only", () => {
    expect(readWorkArea("Engineer - France only", null, area, geo)).toMatchObject({ sure: true, quote: "France only" });
    expect(description("Engineer - France only").sure).toBe(false);
  });

  it("agrees across sentences and keeps the phrase as its quote", () => {
    expect(description("You must live in Germany. Remote within Germany.")).toMatchObject({ sure: true, countries: ["DE"] });
    expect(description("You must be based in France.")).toMatchObject({ sure: true, quote: "You must be based in France" });
  });

  it("reads the title too", () => {
    expect(readWorkArea("Engineer (France only)", null, area, geo)).toMatchObject({ sure: true, countries: ["FR"] });
  });

  it.each([
    ["spaces after a sentence", `You must live in France.\na${" ".repeat(50_000)}b`],
    ["spaces inside a phrase", `You must${" ".repeat(50_000)}live in France.`],
    ["a long hyphenated word", `You must live in France for ${"a-".repeat(25_000)}`],
  ])("stays fast on %s", (_shape, long) => {
    const start = performance.now();
    readWorkArea("Engineer", long, area, geo);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("stays fast on a long text with no sentence ends", () => {
    const long = "must live in ".concat("word ".repeat(40_000));
    const start = performance.now();
    expect(readWorkArea("Engineer", long, area, geo).sure).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
