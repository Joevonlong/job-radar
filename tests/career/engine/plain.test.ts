// @vitest-environment node
import { resumeFromYaml as parseResume, fixture } from "./helpers/fixtures";
import { expect, test } from "vitest";
import { plainResume } from "../../../src/lib/career/engine/plain";
import { } from "../../../src/lib/career/engine/render";

const doc = `
meta: { lang: en }
basics:
  name: Lena Hartmann
  title: AI Engineer
  location: Berlin
  email: lena@example.com
  links: [{ label: GitHub, url: "https://github.com/example" }]
  summary: Builds **measurable** systems with \`pgvector\` and [[Evals:green]]. See [blog](https://example.dev/blog).
experience:
  - company: Northwind
    role: Senior Engineer
    start: 2024-02
    end: present
    location: Berlin
    bullets: ["Cut cost by **48%** using [the docs](https://example.dev/docs)."]
    stack: [Python, AWS]
skills:
  - { group: Languages, items: [Python, SQL] }
sections:
  - summary
  - skills
  - title: Readiness
    items: ["[x] On-call documented", "[ ] SOC 2 evidence"]
  - experience
`;

test("plain text: header, i18n headings in sections order, entry lines, bullets, stack, no markup", () => {
  const txt = plainResume(parseResume(doc));
  const lines = txt.split("\n");
  expect(lines.slice(0, 4)).toEqual(["Lena Hartmann", "AI Engineer", "Berlin | lena@example.com", "GitHub: https://github.com/example"]);
  const headings = lines.filter((l) => /^[A-Z ]+$/.test(l));
  expect(headings).toEqual(["PROFILE", "SKILLS", "READINESS", "EXPERIENCE"]);
  expect(txt.includes("Senior Engineer — Northwind | Berlin | Feb 2024 – Present\n- Cut cost by 48% using the docs (https://example.dev/docs).\nTech stack: Python, AWS")).toBeTruthy();
  expect(txt.includes("Languages: Python, SQL")).toBeTruthy();
  expect(txt.includes("[x] On-call documented\n[ ] SOC 2 evidence")).toBeTruthy();
  expect(txt.includes("Builds measurable systems with pgvector and Evals. See blog (https://example.dev/blog).")).toBeTruthy();
  expect(txt).not.toMatch(/\*\*|\[\[|`|\]\(/);
  expect(txt.endsWith("\n")).toBeTruthy();
});

test("plain text: a built-in's own heading", () => {
  const lines = plainResume(parseResume(doc.replace("  - experience\n", "  - { use: experience, title: Work History }\n"))).split("\n");
  expect(lines.filter((l) => /^[A-Z ]+$/.test(l))).toEqual(["PROFILE", "SKILLS", "READINESS", "WORK HISTORY"]);
});

test("plain text: sections that are not listed or are empty do not appear", () => {
  const txt = plainResume(parseResume(doc.replace("  - summary\n", "")));
  expect(txt).not.toMatch(/PROFILE/);
  expect(plainResume(parseResume("basics: { name: A B, title: T }"))).not.toMatch(/EXPERIENCE|SKILLS/);
});

test("plain text: German headings and date format", () => {
  const txt = plainResume(parseResume(fixture("sample.de.yaml")));
  expect(txt).toMatch(/\nBERUFSERFAHRUNG\n\nSenior AI Engineer — Northwind Analytics \| Berlin · hybrid \| 02\/2024 – heute\n/);
  expect(txt).toMatch(/^Lena Hartmann\n.*\nMusterstraße 12, 10115 Berlin \| lena\.hartmann@example\.com \| \+49 30 0000000 \| EU-Bürgerin\nVerfügbar: ab 01\/2027\n/);
});
