// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { compileFilter, evaluateJob, vmTimeBox, type FilterJob } from "@/lib/filter";
import { startWorkAreaRun, type WorkAreaRun } from "@/lib/filter/rules";
import { isNoteReason, parseFilterReason } from "@/lib/filter/reasons";
import { compileLivePlaces, namesLivePlace } from "@/lib/filter/work-area";
import { workAreaPatterns } from "@/lib/market/schema";
import { UNCLEAR_LOCATION_NOTES } from "@/lib/scoring/score-task";

import { job, loc, prefs } from "./helpers";
import { fixtureMarket, pipelineWith, shippedPipelineFile } from "../pipeline/helpers";

const market = fixtureMarket({ pack: "generic", country: "DE", currency: "EUR", home_language: "de" });
const pipeline = pipelineWith((raw) => {
  const remote = (raw.filter as { remote: Record<string, unknown> }).remote;
  remote.work_area_patterns = ["\\bmust live in (?<place>[^:()|]{2,120})"];
  remote.work_area_title_patterns = ["\\((?<place>[^)]{2,60}) only\\)"];
  remote.work_area_anywhere_patterns = ["\\bwork from anywhere\\b"];
  remote.work_area_negation_patterns = ["\\bnot\\b"];
  remote.work_area_connectors = ["\\s+or\\s+"];
  remote.work_area_endings = ["to\\s+apply"];
  remote.work_area_continuations = ["\\bother\\b"];
  remote.work_area_articles = ["the"];
}, market);

type Place = { place: string; relocate: boolean };

function verdict(places: Place[], over: Partial<FilterJob>) {
  const preferences = prefs((raw) => {
    raw.home_city = "Berlin";
    raw.places = places;
    raw.workplace = ["onsite", "hybrid", "remote"];
  });
  return evaluateJob(job({ workplace: "remote", locations: [loc("Germany", null, "DE")], ...over }), compileFilter(preferences, pipeline, { me: null, watchedCompanies: [] }));
}
const areaReasons = (places: Place[], over: Partial<FilterJob>) => verdict(places, over).reasons.filter((reason) => /^(remote_out_of_scope|remote_area_unknown)/.test(reason));
const says = (description: string): Partial<FilterJob> => ({ description });

describe("check 2 on a remote job check 1 kept", () => {
  it("passes a clear statement of the home country", () => {
    expect(areaReasons([], says("You must live in Germany."))).toEqual([]);
  });

  it("passes a clear statement of a country I would move to, and hides one that is remote-only for me", () => {
    expect(areaReasons([{ place: "NL", relocate: true }], says("You must live in the Netherlands."))).toEqual([]);
    expect(areaReasons([{ place: "NL", relocate: false }], says("You must live in the Netherlands."))).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
  });

  it("hides a clear statement of another country, with the phrase as its detail", () => {
    const reason = areaReasons([], says("You must live in France."))[0] ?? "";
    expect(parseFilterReason(reason)).toMatchObject({ code: "remote_out_of_scope", detail: "must live in France" });
    expect(verdict([], says("You must live in France.")).result).toBe("filtered_out");
  });

  it("passes when one of the listed countries is covered, and when the posting says anywhere", () => {
    expect(areaReasons([], says("You must live in France or Germany."))).toEqual([]);
    expect(areaReasons([], says("You can work from anywhere."))).toEqual([]);
  });

  it("keeps everything else with the note", () => {
    for (const text of ["Our office is in France.", "You do not have to, but must live in France.", "You must live in Smalltown.", "You must live in France. You must live in Germany."]) {
      expect(areaReasons([], says(text)), text).toEqual(["remote_area_unknown"]);
    }
  });

  it("runs on a remote job that passed on its listed city, the early return of check 1", () => {
    const inBerlin = { locations: [loc("Berlin", "Berlin", "DE")] };
    expect(areaReasons([], { ...inBerlin, ...says("You must live in France.") })).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
    expect(areaReasons([], { ...inBerlin, ...says("Our office is in France.") })).toEqual(["remote_area_unknown"]);
  });

  it("reads the title too", () => {
    expect(areaReasons([], { title: "Engineer, must live in France", description: "" })).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
    expect(areaReasons([], { title: "Engineer (France only)", description: "" })).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
    expect(areaReasons([], says("Medical cover (France only)"))).toEqual(["remote_area_unknown"]);
  });

  it("keeps a clear statement elsewhere with the note when a place I'd move to has no country to compare", () => {
    expect(areaReasons([{ place: "Smalltown", relocate: true }], says("You must live in France."))).toEqual(["remote_area_unknown"]);
    expect(areaReasons([{ place: "Worldwide", relocate: false }], says("You must live in France."))).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
  });

  it("keeps a clear statement elsewhere with the note when the posting also names a place I can take", () => {
    expect(areaReasons([], says("You must live in France. Candidates in Germany are welcome too."))).toEqual(["remote_area_unknown"]);
    expect(areaReasons([{ place: "NL", relocate: true }], says("You must live in France. Our office is in the Netherlands."))).toEqual(["remote_area_unknown"]);
    expect(areaReasons([{ place: "NL", relocate: false }], says("You must live in France. Our office is in the Netherlands."))).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
    expect(areaReasons([], says("You must live in France. Fluent German is a plus."))).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
  });

  it("hears a place I can take in the title, and a city I live in or would move to", () => {
    expect(areaReasons([], { title: "Engineer Germany", description: "You must live in France." })).toEqual(["remote_area_unknown"]);
    expect(areaReasons([], says("You must live in France. Our office is in Berlin."))).toEqual(["remote_area_unknown"]);
    expect(areaReasons([{ place: "Paris", relocate: true }], says("You must live in Spain. Greetings from Paris."))).toEqual(["remote_area_unknown"]);
    expect(areaReasons([{ place: "Paris", relocate: false }], says("You must live in Spain. Greetings from Paris."))).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
  });

  it("does not run on on-site or hybrid jobs, or a remote job check 1 already hid", () => {
    expect(areaReasons([], { workplace: "hybrid", locations: [loc("Berlin", "Berlin", "DE")], ...says("You must live in France.") })).toEqual([]);
    expect(areaReasons([], { locations: [loc("USA", null, "US")], ...says("You must live in Spain.") })).toEqual([expect.stringMatching(/^remote_out_of_scope/)]);
  });

  it("adds a note that excludes nothing", () => {
    const kept = verdict([], says("Our office is in France."));
    expect(kept.result).toBe("passed");
    expect(isNoteReason("remote_area_unknown")).toBe(true);
    expect(UNCLEAR_LOCATION_NOTES.has("remote_area_unknown")).toBe(false);
  });

  it("is silent with no phrases configured: every remote job only gets the note", () => {
    const bare = pipelineWith(() => {}, market);
    const preferences = prefs((raw) => {
      raw.home_city = "Berlin";
      raw.places = [];
      raw.workplace = ["remote"];
    });
    const result = evaluateJob(job({ workplace: "remote", locations: [loc("Germany", null, "DE")], description: "You must live in France." }), compileFilter(preferences, bare, { me: null, watchedCompanies: [] }));
    expect(result.result).toBe("passed");
    expect(result.reasons).toContain("remote_area_unknown");
  });
});

describe("compileLivePlaces", () => {
  const names = (spellings: string[], text: string) => namesLivePlace("Engineer", text, compileLivePlaces(spellings));

  it("matches whole words of any spelling, whatever the white space or case", () => {
    expect(names(["St. Gallen"], "Near St. Gallen.")).toBe(true);
    expect(names(["Frankfurt (Oder)"], "In Frankfurt (Oder).")).toBe(true);
    expect(names(["New York"], "In new\nyork.")).toBe(true);
    expect(names(["Essen"], "Essener Strasse")).toBe(false);
  });

  it("takes a short name in capitals only", () => {
    expect(names(["UK"], "UK candidates welcome.")).toBe(true);
    expect(names(["US"], "Join us today.")).toBe(false);
    expect(names(["Ulm"], "ULM")).toBe(false);
  });

  it("has nothing to look for without spellings", () => {
    expect(names([], "Germany")).toBe(false);
  });
});

describe("the phrase list", () => {
  it("refuses a phrase that captures no place, and a broken one", () => {
    expect(workAreaPatterns.safeParse(["\\bmust live in (?<place>.+)"]).success).toBe(true);
    expect(workAreaPatterns.safeParse(["\\bmust live in .+"]).success).toBe(false);
    expect(workAreaPatterns.safeParse(["(?<place>["]).success).toBe(false);
  });

  it("is refused in pipeline.yaml without a place capture", () => {
    const parsed = configRegistry.pipeline.schema.safeParse({ ...shippedPipelineFile(), filter: { ...shippedPipelineFile().filter, remote: { ...shippedPipelineFile().filter.remote, work_area_patterns: ["\\bmust live in .+"] } } });
    expect(parsed.success).toBe(false);
  });
});

describe("a statement naming a city", () => {
  it("is not sure, because the same name may be a town at home", () => {
    expect(areaReasons([], says("You must live in Paris."))).toEqual(["remote_area_unknown"]);
    expect(areaReasons([], says("You must live in Paris or France."))).toEqual(["remote_area_unknown"]);
  });
});

describe("what a posting can cost", () => {
  it("keeps a quote short, whatever the phrase matched", () => {
    const long = pipelineWith((raw) => {
      (raw.filter as { remote: Record<string, unknown> }).remote.work_area_patterns = ["must live in (?<place>France)[\\s\\S]*"];
      (raw.filter as { remote: Record<string, unknown> }).remote.work_area_endings = [".*"];
    }, market);
    const filter = compileFilter(prefs((raw) => (raw.home_city = "Berlin")), long, { me: null, watchedCompanies: [] });
    const { reasons } = evaluateJob(job({ workplace: "remote", locations: [loc("Germany", null, "DE")], description: `You must live in France ${"x".repeat(5000)}` }), filter);
    const reason = reasons.find((text) => text.startsWith("remote_out_of_scope")) ?? "";
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThan(300);
  });

  describe("a phrase that is slow on a posting", () => {
    const slow = pipelineWith((raw) => {
      (raw.filter as { remote: Record<string, unknown> }).remote.work_area_patterns = ["^(?<place>(a+)+)$"];
    }, market);
    const filter = compileFilter(prefs((raw) => (raw.home_city = "Berlin")), slow, { me: null, watchedCompanies: [] });
    const posting = job({ workplace: "remote", locations: [loc("Germany", null, "DE")], description: `${"a".repeat(40)}b` });
    const area = (reasons: readonly string[]) => reasons.filter((reason) => /^(remote_out_of_scope|remote_area)/.test(reason));

    const context = (run: WorkAreaRun, previous?: readonly string[]) => ({ run, jobId: 7, previous });

    it("is stopped, leaves the job visible with a note, and marks that job's verdict as not final", () => {
      const run = startWorkAreaRun(filter, vmTimeBox);
      expect(area(evaluateJob(posting, filter, null, [], context(run)).reasons)).toEqual(["remote_area_unknown"]);
      expect([...run.unread]).toEqual([7]);
    });

    it("uses up the run's budget, and later postings are not read at all", () => {
      let calls = 0;
      const run: WorkAreaRun = { timeBox: () => { calls += 1; return false; }, jobMs: 60, left: 100, unread: new Set() };
      for (let i = 0; i < 5; i += 1) expect(area(evaluateJob(posting, filter, null, [], context(run)).reasons)).toEqual(["remote_area_unknown"]);
      expect(calls).toBe(2);
    });

    it("keeps a hide the job had, so a slow machine never shows a hidden job", () => {
      const run: WorkAreaRun = { timeBox: () => false, jobMs: 60, left: 100, unread: new Set() };
      const verdict = evaluateJob(posting, filter, null, [], context(run, ["remote_out_of_scope:must live in France"]));
      expect(verdict).toEqual({ result: "filtered_out", reasons: ["remote_out_of_scope:must live in France"] });
    });

    it("leaves a normal run final", () => {
      const fine = compileFilter(prefs((raw) => (raw.home_city = "Berlin")), pipeline, { me: null, watchedCompanies: [] });
      const run = startWorkAreaRun(fine, vmTimeBox);
      evaluateJob(job({ workplace: "remote", locations: [loc("Germany", null, "DE")], description: "You must live in France." }), fine, null, [], { run, jobId: 7 });
      expect(run.unread.size).toBe(0);
    });
  });
});
