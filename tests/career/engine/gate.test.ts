// @vitest-environment node
import { LIMITS, COMPILED, OPTIONS, resumeFromYaml as parseResume, fixture } from "./helpers/fixtures";
import { expect, test } from "vitest";
import { parse, stringify } from "yaml";

import { textPdf } from "./helpers/pdf";
import { runCheck } from "../../../src/lib/career/engine/check";
import { shipBlockers } from "../../../src/lib/career/engine/gate";
import { jdMatch, orGroups, parseJd } from "../../../src/lib/career/engine/jd";
import { } from "../../../src/lib/career/engine/render";

test("shipBlockers: placeholders and the page budget block; a finished one-pager doesn't", async () => {
  const r = parseResume(fixture("sample.en.yaml"));
  expect(shipBlockers(r, "resume", { limits: LIMITS, pages: 1 })).toEqual([]);
  expect(shipBlockers(r, "resume", { limits: LIMITS, pages: 2 })).toEqual([{ code: "career.gate.pages", params: { pages: 2, budget: 1 } }]);
  const doc = parse(fixture("sample.en.yaml"));
  doc.basics.title = "⟨Your title⟩";
  doc.experience[0].start = "0000-01";
  expect(shipBlockers(parseResume(stringify(doc)), "resume", { limits: LIMITS })).toEqual([{ code: "career.gate.placeholders", params: { count: 2, where: "basics.title, experience[0].start" } }]);
});

test("JD alternatives: 'A, B oder C' and 'A/B' are one requirement; 'and' and plain lists are not", () => {
  const { groups } = orGroups("Frontends mit React, Angular oder Vue. Python and Go or Rust. Java/Kotlin, Docker, Kubernetes.", COMPILED);
  expect(groups).toEqual([["React", "Angular", "Vue"], ["Go", "Rust"], ["Java", "Kotlin"]]);
  const m = jdMatch(parseJd("## Requirements\n- Frontends with React, Angular or Vue\n- Docker, Kubernetes\n", LIMITS), "We build in Vue and Docker.", COMPILED);
  expect(m.required.exact.map((t) => t.term)).toEqual(["React / Angular / Vue", "Docker"]);
  expect(m.required.missing.map((t) => t.term)).toEqual(["Kubernetes"]);
});

test("JD language note: a German posting for an English resume says so (info); the same language says nothing", async () => {
  const r = parseResume(fixture("sample.en.yaml"));
  const de = parseJd(fixture("jd.de.md"), LIMITS);
  const en = parseJd(fixture("jd.sample.md"), LIMITS);
  const pdf = textPdf([["Lena Hartmann"]]);
  const withDe = await runCheck(r, pdf, { ...OPTIONS, jd: de });
  expect(withDe.jd?.lang?.level).toBe("info");
  expect(withDe.jd?.lang).toMatchObject({ code: "career.check.language_mismatch", params: { reads: "de", lang: "en" } });
  expect((await runCheck(r, pdf, { ...OPTIONS, jd: en })).jd?.lang).toBe(undefined);
});

test("placeholder blockers retain the first three paths and a separate overflow count", () => {
  const r = parseResume('basics: { name: "⟨Name⟩", title: "⟨Title⟩", phone: "⟨Phone⟩", summary: "⟨Summary⟩" }');
  expect(shipBlockers(r, "resume", { limits: LIMITS })).toEqual([{ code: "career.gate.placeholders", params: { count: 4, where: "basics.name, basics.title, basics.phone", more: 1 } }]);
});
