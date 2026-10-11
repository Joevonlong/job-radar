// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createPersonioChannel, personioAdapter } from "@/lib/channels/ats";
import { wrapPosting } from "@/lib/channels/ats/envelope";
import { ChannelError } from "@/lib/channels/errors";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { atsChannelsWith, atsContext, company, depsWith, fixtureText, inputs, response, routedFetch } from "./helpers";

const URL_PART = "examplelabs.jobs.personio.de/xml";
const personio = company({ name: "Example Labs", ats: "personio", token: "examplelabs" });
const feed = () => fixtureText("personio-feed.xml");

function channel() {
  const deps = depsWith(inputs([personio]));
  return { channel: createPersonioChannel(deps), store: deps.memory };
}

/** Run the sweep once against the fixture feed and return the stored postings. */
async function sweep(edit: (b: Record<string, unknown>) => void = () => {}) {
  const channels = atsChannelsWith("personio", (b) => {
    b.title_prefilter = { enabled: false, include_terms: [], exclude_terms: [] };
    edit(b);
  });
  const { fetch, requests } = routedFetch([["/xml", response(200, feed(), { ETag: '"abc"' })]]);
  const { ctx, query, logs } = atsContext("personio", fetch, { channels });
  const c = channel();
  const postings = await c.channel.collect(query, ctx);
  return { postings, requests, logs, ...c, parse: (i: number) => c.channel.parse(postings[i]?.payload) };
}

describe("personio feed", () => {
  it("requests the XML feed in the configured language and stores one posting per position", async () => {
    const { postings, requests, logs } = await sweep();
    expect(requests[0]?.url).toBe("https://examplelabs.jobs.personio.de/xml?language=en");
    expect(requests[0]?.headers.Accept).toBe("application/xml");
    expect(postings.map((p) => p.externalId)).toEqual(["2756691", "2365712", "2650486", "2650487"]);
    expect(postings[0]?.url).toBe("https://examplelabs.jobs.personio.de/job/2756691");
    expect(postings[0]?.postedAt).toEqual(new Date("2026-08-17T09:11:14+00:00"));
    expect(logs.filter((l) => l.message === "ats board").map((l) => l.fields)).toEqual([
      { channel: "personio", company: "Example Labs", board: "examplelabs", outcome: "changed", fetched: 4, kept: 4 },
    ]);
  });

  it("uses language de and a custom site template", async () => {
    const { requests } = await sweep((b) => {
      b.language = "de";
      b.api_base_url = "https://jobs.example.test/{token}/";
    });
    expect(requests[0]?.url).toBe("https://jobs.example.test/examplelabs/xml?language=de");
  });

  it("keeps only titles matching the search keywords by default", async () => {
    const { fetch } = routedFetch([[URL_PART, response(200, feed())]]);
    const channels = atsChannelsWith("personio", () => {});
    const { ctx, query } = atsContext("personio", fetch, { channels });
    const postings = await channel().channel.collect(query, ctx);
    // "Machine Learning Engineer (m/w/d)" and "KI-Entwickler:in" match; the CTO and sales titles do not
    expect(postings.map((p) => p.externalId)).toEqual(["2365712", "2650487"]);
  });

  it("answers 304 with an unchanged feed", async () => {
    const c = channel();
    const first = atsContext("personio", routedFetch([[URL_PART, response(200, feed(), { ETag: '"abc"' })]]).fetch);
    await c.channel.collect(first.query, first.ctx);
    expect(c.store.states.get("personio:examplelabs")?.etag).toBe('"abc"');

    const second = routedFetch([[URL_PART, response(304)]]);
    const b = atsContext("personio", second.fetch);
    expect(await c.channel.collect(b.query, b.ctx)).toEqual([]);
    expect(second.requests[0]?.headers["If-None-Match"]).toBe('"abc"');
    expect(c.store.checks.at(-1)).toMatchObject({ update: { status: "not_modified" } });
  });

  it("an empty feed is an empty board; a 404 is a missing board; a non-XML answer is a parse error", async () => {
    const empty = atsContext("personio", routedFetch([[URL_PART, response(200, fixtureText("personio-empty.xml"))]]).fetch);
    expect(await channel().channel.collect(empty.query, empty.ctx)).toEqual([]);

    const missing = atsContext("personio", routedFetch([[URL_PART, response(404, "Not found")]]).fetch);
    await expect(channel().channel.collect(missing.query, missing.ctx)).rejects.toThrow(/not found/);

    const html = atsContext("personio", routedFetch([[URL_PART, response(200, "<html><body>Maintenance</body></html>")]]).fetch);
    await expect(channel().channel.collect(html.query, html.ctx)).rejects.toMatchObject({ code: "parse" });
  });
});

describe("personio parse", () => {
  it("maps a position with sections, entities and several offices", async () => {
    const { parse } = await sweep();
    const d = parse(1);
    expect(normalizedPostingDraftSchema.parse(d)).toBeTruthy();
    expect(d).toMatchObject({
      title: "Machine Learning Engineer (m/w/d)",
      companyName: "Example Labs",
      workplace: "remote",
      contractHint: "permanent, full-or-part-time",
      seniorityHint: "experienced",
      salary: null,
      salaryText: null,
      applyUrl: "https://examplelabs.jobs.personio.de/job/2365712",
      sourceUrl: "https://examplelabs.jobs.personio.de/job/2365712",
    });
    expect(d.locations.map((l) => l.label)).toEqual(["Berlin", "Remote", "München"]);
    expect(d.description).toBe(
      "Was wir machen\nWir bauen KI-Werkzeuge für die Klinik der Zukunft.\n\nGegründet im Jahr 2024.\n\nDeine Aufgaben\n- Robotic Process Automation & UI automation agents\n- SDKs & Bibliotheken",
    );
    expect(d.postedAt).toEqual(new Date("2026-05-04T12:00:00+00:00"));
    expect(d.extra).toMatchObject({ ats: "personio", keywords: ["AI", "Python", "Docker"], yearsOfExperience: "2-5", department: "Engineering" });
  });

  it("handles empty descriptions, an ampersand in the title and the 'Remote / Hybrid' label (workplace stays unknown)", async () => {
    const { parse } = await sweep();
    const d = parse(0);
    expect(d.title).toBe("Co-founder & CTO (Stealth AI Infrastructure Venture)");
    expect(d.description).toBe("");
    expect(d.workplace).toBe("unknown");
    expect(d.locations.map((l) => l.label)).toEqual(["Zürich", "Remote / Hybrid"]);
    expect(parse(2).workplace).toBe("unknown");
    expect(parse(2).contractHint).toBe("intern, part-time");
  });

  it("reads CDATA, a hybrid label and an invalid date", async () => {
    const { parse } = await sweep();
    const d = parse(3);
    expect(d.workplace).toBe("hybrid");
    expect(d.description).toBe("Aufgaben\nEntwickle LLM-Anwendungen & Agenten");
    expect(d.postedAt).toBeNull();
  });

  it("rejects a position without a name and a payload from another ATS", () => {
    const source = { ats: "personio", token: "examplelabs", companyName: "Example Labs" } as const;
    expect(() => personioAdapter.parse(wrapPosting(source, { id: "1" }))).toThrow(ChannelError);
    expect(() => personioAdapter.parse(wrapPosting({ ...source, ats: "ashby" }, { id: "1", name: "x" }))).toThrow(/personio posting envelope/);
  });

  it("list() rejects a body that is not a decoded feed", () => {
    expect(() => personioAdapter.list({ jobs: [] })).toThrow(ChannelError);
    expect(() => personioAdapter.list(null)).toThrow(ChannelError);
  });
});
