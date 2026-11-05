// @vitest-environment node
import { expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { fixture } from "./helpers/fixtures";
import { textPdf } from "./helpers/pdf";
import { runCheck } from "../../../src/lib/career/engine/check";
import { shipBlockers } from "../../../src/lib/career/engine/gate";
import { jdMatch, orGroups, parseJd } from "../../../src/lib/career/engine/jd";
import { parseResume } from "../../../src/lib/career/engine/render";

test("shipBlockers: placeholders and the page budget block; a finished one-pager doesn't", async () => {
  const r = parseResume(fixture("sample.en.yaml"));
  expect(shipBlockers(r, "resume", 1)).toEqual([]);
  expect(shipBlockers(r, "resume", 2).join()).toMatch(/2 pages, over the budget of 1/);
  const doc = parse(fixture("sample.en.yaml"));
  doc.basics.title = "⟨Your title⟩";
  doc.experience[0].start = "0000-01";
  expect(shipBlockers(parseResume(stringify(doc)), "resume").join()).toMatch(/2 unfinished placeholders \(basics\.title, experience\[0\]\.start\)/);
});

test("JD alternatives: 'A, B oder C' and 'A/B' are one requirement; 'and' and plain lists are not", () => {
  const { groups } = orGroups("Frontends mit React, Angular oder Vue. Python and Go or Rust. Java/Kotlin, Docker, Kubernetes.");
  expect(groups).toEqual([["React", "Angular", "Vue"], ["Go", "Rust"], ["Java", "Kotlin"]]);
  const m = jdMatch(parseJd("## Requirements\n- Frontends with React, Angular or Vue\n- Docker, Kubernetes\n"), "We build in Vue and Docker.");
  expect(m.required.exact.map((t) => t.term)).toEqual(["React / Angular / Vue", "Docker"]);
  expect(m.required.missing.map((t) => t.term)).toEqual(["Kubernetes"]);
});

test("JD language note: a German posting for an English resume says so (info); the same language says nothing", async () => {
  const r = parseResume(fixture("sample.en.yaml"));
  const de = parseJd(fixture("jd.de.md"));
  const en = parseJd(fixture("jd.sample.md"));
  const pdf = textPdf([["Lena Hartmann"]]);
  const withDe = await runCheck(r, pdf, { jd: de });
  expect(withDe.jd?.lang?.level).toBe("info");
  expect(withDe.jd?.lang?.message ?? "").toMatch(/the JD is in German, your resume in English/);
  expect((await runCheck(r, pdf, { jd: en })).jd?.lang).toBe(undefined);
});
