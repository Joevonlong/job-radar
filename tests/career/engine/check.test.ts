// @vitest-environment node
import { LEXICON, issuesOf, OPTIONS, LIMITS, COMPILED, DAY, resumeFromYaml as parseResume, fixture } from "./helpers/fixtures";
import { compileLexicon } from "../../../src/lib/career/engine/compile-lexicon";



import { expect, test } from "vitest";
import { runCheck } from "../../../src/lib/career/engine/check";
import { extractText, headingIn, missingContent, parserProblems } from "../../../src/lib/career/engine/extract";
import { degreeRequirement, jdMatch, languageRequirements, levelRank, parseJd, segmentJd, titleGap } from "../../../src/lib/career/engine/jd";
import { findHits } from "../../../src/lib/career/engine/keywords";
import { type Issue, lint } from "../../../src/lib/career/engine/lint";
import { plainResume } from "../../../src/lib/career/engine/plain";
import { imagePng } from "./helpers/images";
import { textPdf } from "./helpers/pdf";
import { md } from "../../../src/lib/career/engine/md";
import { listThemes, renderResume } from "../../../src/lib/career/engine/render";

const BASICS = 'basics: { name: Test Person, title: Engineer, phone: "+49 30 000000", workAuth: EU citizen, summary: s }\n';
const errorOf = (yaml: string) => issuesOf(yaml)[0];

const bulletIssues = (bullets: string[], extra = "") =>
  lint(parseResume(`${BASICS}experience:\n  - { company: A, role: R, start: 2020, end: present, bullets: ${JSON.stringify(bullets)} }\n${extra}`), OPTIONS);
const has = (issues: Issue[], code: string | string[], params?: Record<string, unknown>) => issues.some((i) =>
  (Array.isArray(code) ? code.includes(i.code) : i.code === code) && (!params || expect.objectContaining(params).asymmetricMatch(i.params)),
);

test("experience / education end before start is a schema error at the entry", () => {
  const exp = errorOf(`${BASICS}experience:\n  - { company: A, role: R, start: 2021-06, end: 2019-01 }\n`);
  expect(exp).toMatchObject({"code":"career.schema.end_before_start","params":{"end":"2019-01","start":"2021-06"}});
  expect(exp).toMatchObject({"path":"experience.0.end"});
  const edu = errorOf(`${BASICS}education:\n  - { school: S, degree: D, start: 2018, end: 2017 }\n`);
  expect(edu).toMatchObject({"path":"education.0.end"});
  for (const [s, e] of [["2023", "2023-05"], ["2023-05", "2023"], ["2020", "present"]])
    expect(parseResume(`${BASICS}experience:\n  - { company: A, role: R, start: ${s}, end: ${e} }\n`)).toBeTruthy();
});

test("lint: pronoun openers and weak openers (EN / DE), not their look-alikes", () => {
  expect(has(bulletIssues(["I built the billing service used by 40 teams across Europe"]), "career.lint.pronoun", { pronoun: "I" })).toBeTruthy();
  expect(has(bulletIssues(["Wir haben die Plattform für 40 Teams in Europa neu gebaut"]), "career.lint.pronoun", { pronoun: "Wir" })).toBeTruthy();
  expect(has(bulletIssues(["Responsible for the billing service used by 40 teams in Europe"]), "career.lint.weak_opener", { text: "Responsible for" })).toBeTruthy();
  expect(has(bulletIssues(["I was responsible for the billing service used by 40 teams"]), "career.lint.weak_opener", { text: "responsible for" })).toBeTruthy();
  expect(has(bulletIssues(["Verantwortlich für den Abrechnungsdienst mit 40 Teams in Europa"]), "career.lint.weak_opener")).toBeTruthy();
  expect(has(bulletIssues(["Helped 3 teams migrate their services to the new platform"]), "career.lint.weak_opener", { text: "Helped" })).toBeTruthy();
  const fine = bulletIssues(["IT asset inventory automated for 40 teams, saving 2 days a month", "Iterated on the billing service until p95 fell by 40%", "Helmed the move of 40 services to Kubernetes in 3 months"]);
  expect(!has(fine, ["career.lint.pronoun","career.lint.weak_opener"]), JSON.stringify(fine)).toBeTruthy();
});

test("lint: passive voice is info (EN / DE); active sentences pass", () => {
  const en = bulletIssues(["The pipeline was rebuilt and build time fell from 24 to 7 minutes"]);
  expect(en.find((i) => i.code === "career.lint.passive")?.level).toBe("info");
  expect(has(bulletIssues(["Die Plattform wurde in 3 Monaten von mir entwickelt und eingeführt"]), "career.lint.passive", { text: expect.stringMatching(/^wurde/) })).toBeTruthy();
  expect(has(bulletIssues(["Ein Abrechnungsdienst wurde für 40 Teams implementiert"]), "career.lint.passive")).toBeTruthy();
  expect(!has(bulletIssues(["Rebuilt the pipeline; build time fell from 24 to 7 minutes", "Wurde zum Teamlead für 6 Entwickler im Plattformteam"]), "career.lint.passive")).toBeTruthy();
});

test("lint: duplicates, repeated opening verbs, short bullets", () => {
  const dup = bulletIssues(["Cut p95 latency by 40% across 12 services", "Cut **p95 latency** by 40% across 12 services."]);
  expect(dup.find((i) => i.code === "career.lint.duplicate_bullet")).toMatchObject({ code: "career.lint.duplicate_bullet", params: { where: "experience[0].bullets[0]" } });
  const verbs = bulletIssues(["Built the billing service for 40 teams in Europe", "Built a feature-flag system used by 12 teams", "Built a deploy pipeline that cut releases to 7 minutes"]);
  expect(has(verbs, "career.lint.repeated_opener", { count: 3, verb: "built" })).toBeTruthy();
  expect(!has(bulletIssues(["Built the billing service for 40 teams in Europe", "Built a feature-flag system used by 12 teams"]), "career.lint.repeated_opener")).toBeTruthy();
  const short = bulletIssues(["Did 3 things", "Cut p95 latency by 40% across 12 services"]);
  expect(short.filter((i) => i.code === "career.lint.bullet_short")).toEqual([{ level: "info", where: "experience[0].bullets[0]", code: "career.lint.bullet_short", params: { count: 12, text: "Did 3 things" } }]);
});

test("lint: most recent role needs a number; overall ratio stays info", () => {
  const y = `${BASICS}experience:
  - { company: New, role: R, start: 2022, end: present, bullets: [Rebuilt the billing service for the whole company] }
  - { company: Old, role: R, start: 2019, end: 2021, bullets: [Cut p95 latency by 40% across 12 services] }
`;
  const issues = lint(parseResume(y), OPTIONS);
  expect(issues.find((i) => i.code === "career.lint.recent_unquantified" && i.params?.company === "New")?.level).toBe("warn");
  expect(!has(lint(parseResume(y.replace("whole company", "whole company, 12 teams")), OPTIONS), "career.lint.recent_unquantified")).toBeTruthy();
});

test("lint: German filler words, with inflections; not inside other words", () => {
  const r = parseResume(`${BASICS.replace("summary: s", 'summary: "Hochmotivierter, teamfähiger und belastbarer Entwickler"')}`);
  const filler = lint(r, OPTIONS).find((i) => i.where === "basics.summary")!;
  expect(filler).toMatchObject({ code: "career.lint.filler", params: { terms: "hochmotivierter, teamfähiger, belastbarer" } });
  expect(!lint(parseResume(BASICS.replace("summary: s", "summary: A flexible schema for 40 services")), OPTIONS).some((i) => i.code === "career.lint.filler")).toBeTruthy();
});

test("lint: body language vs meta.lang", () => {
  const en = "Built the billing service for the company and cut the cost of the platform by 40% with a cache on the edge";
  const de = "Den Abrechnungsdienst für das Unternehmen aufgebaut und die Kosten der Plattform mit einem Cache um 40% gesenkt, auch bei der Last";
  const lang = (l: string, b: string) => lint(parseResume(`meta: { lang: ${l} }\n${BASICS}experience:\n  - { company: A, role: R, start: 2020, end: present, bullets: ["${b}", "${b} again"] }\n`), OPTIONS);
  expect(has(lang("de", en), "career.lint.language_mismatch", { lang: "de", reads: "en" })).toBeTruthy();
  expect(has(lang("en", de), "career.lint.language_mismatch", { reads: "de" })).toBeTruthy();
  expect(!has(lang("en", en), "career.lint.language_mismatch")).toBeTruthy();
  expect(!has(lang("de", de), "career.lint.language_mismatch")).toBeTruthy();
});

test("lint: contact details", () => {
  const issues = lint(parseResume("basics: { name: A, title: B, phone: 030 000000 }\n"), OPTIONS);
  expect(issues.find((i) => i.where === "basics.phone")?.level).toBe("info");
  expect(issues.find((i) => i.where === "basics.workAuth")?.level).toBe("info");
  expect(lint(parseResume("basics: { name: A, title: B }\n"), OPTIONS).find((i) => i.where === "basics.phone")?.level).toBe("warn");
  expect(!lint(parseResume(BASICS), OPTIONS).some((i) => i.where?.startsWith("basics."))).toBeTruthy();
});

test("lint: dates — order, missing end, gaps", () => {
  const issues = lint(
    parseResume(`${BASICS}experience:
  - { company: Old, role: R, start: 2015-01, end: 2017-12, bullets: [] }
  - { company: Mid, role: R, start: 2018-09, bullets: [] }
  - { company: New, role: R, start: 2020-01, end: present, bullets: [] }
`), OPTIONS
  );
  expect(has(issues, "career.lint.experience_order", { next: "Mid", company: "Old" })).toBeTruthy();
  expect(has(issues, "career.lint.end_missing", { company: "Mid" })).toBeTruthy();
  expect(!has(issues, "career.lint.experience_gap")).toBeTruthy();
  expect(has(lint(parseResume(`${BASICS}experience:\n  - { company: New, role: R, start: 2018-09, end: present }\n  - { company: Old, role: R, start: 2015-01, end: 2017-12 }\n`), OPTIONS), "career.lint.experience_gap", { months: 8, before: "Old", after: "New" })).toBeTruthy();
  const clean = lint(
    parseResume(`${BASICS}experience:
  - { company: New, role: R, start: 2020, end: present, bullets: [] }
  - { company: Side, role: R, start: 2018-03, end: 2019-06, bullets: [] }
  - { company: Old, role: R, start: 2015, end: 2019, bullets: [] }
`), OPTIONS
  );
  expect(!has(clean, ["career.lint.experience_gap","career.lint.experience_order","career.lint.end_missing"]), JSON.stringify(clean)).toBeTruthy();
});

test("lint: skills shown nowhere else are info; dictionary aliases and stack count as shown", () => {
  const r = parseResume(`${BASICS}experience:
  - { company: A, role: R, start: 2020, end: present, bullets: [Moved 12 services to k8s with zero downtime], stack: [Postgres] }
skills:
  - { group: Infra, items: [Kubernetes, PostgreSQL, Terraform, "tool use / MCP"] }
`);
  const only = lint(r, OPTIONS).filter((i) => i.code === "career.lint.skill_unproven").map((i) => i.params?.term);
  expect(only).toEqual(["Terraform", "tool use / MCP"]);
});

test("parserProblems: name first, contact verbatim, headings present", () => {
  const r = parseResume(`basics: { name: Jo Example, title: Engineer, email: jo@example.com, phone: "+49 30 123" }
experience:
  - { company: A, role: R, start: 2020, end: present, bullets: [x] }
sections: [experience, { title: Talks, items: [t] }]
`);
  const good = "Jo Example\nEngineer · jo@example.com · +49 30 123\nExperience R A x Talks t";
  expect(parserProblems(r, good)).toEqual([]);
  const bad = parserProblems(r, "CONTACT\njo@example.com\nJo Example\nExperience R x");
  expect(bad.map((i) => [i.level, i.where])).toEqual([["error", "basics.name"], ["error", "basics.phone"], ["warn", "sections[1].title"]]);
  expect(bad[0]).toMatchObject({ code: "career.extract.name_first", params: { text: "CONTACT" } });
});

test("keywords: JD spelling vs alias; case-sensitive short words; resume-only aliases", () => {
  const jd = parseJd("## Requirements\nDocker, Kubernetes, GitHub Actions, OpenAI, system design and Go.\n", LIMITS);
  const m = jdMatch(jd, "Deployed containers on k8s; CI pipelines; used GPT; architecture of agents; Golang services", COMPILED);
  expect(m.required.exact.map((t) => t.term)).toEqual([]);
  expect(m.required.alias.map((t) => `${t.jd}<-${t.resume}`)).toEqual(["OpenAI<-GPT", "Go<-Golang", "Docker<-containers", "Kubernetes<-k8s", "system design<-architecture"]);
  expect(m.required.missing.map((t) => t.term)).toEqual(["GitHub Actions"]);

  expect(jdMatch(parseJd("LLMs, fine tuning, NodeJS", LIMITS), "LLM fine-tuning Node.js", COMPILED).required.exact.length).toEqual(3);

  expect([...findHits("Our architecture team does performance evaluation of containers; go-live in Q3; R&D", COMPILED, true).keys()]).toEqual([]);
  expect(findHits("Python and R.", COMPILED).has("R")).toBeTruthy();
});

test("a supplied lexicon extends keyword matching", () => {
  const lexicon = structuredClone(LEXICON);
  lexicon.en.keywords.Snowflake = ["Snowflake", "SnowSQL"];
  lexicon.en.keywords.Kubernetes.push("kube");
  const dict = compileLexicon(lexicon);
  const m = jdMatch(parseJd("Snowflake and Kubernetes", LIMITS), "SnowSQL on kube", dict);
  expect(m.required.alias.map((t) => `${t.term}<-${t.resume}`).sort()).toEqual(["Kubernetes<-kube", "Snowflake<-SnowSQL"]);
});

test("JD parts: required / nice / boilerplate by heading, inline label and sentence", () => {
  const seg = segmentJd(`# Data Engineer
## What you bring
- Python and Airflow
- Terraform is a plus
## Nice to have
- Kafka
## Benefits
- Kubernetes training budget
We are an equal opportunity employer.
`, COMPILED);
  expect(seg.required).toMatch(/Python and Airflow/);
  expect(seg.nice).toMatch(/Terraform is a plus/);
  expect(seg.nice).toMatch(/Kafka/);
  expect(seg.skip).toMatch(/Kubernetes training/);
  expect(seg.required + seg.nice).not.toMatch(/Kubernetes|equal opportunity/);
  const inline = segmentJd("Ihr Profil: Java und Go. Wünschenswert: Kafka und Terraform.", COMPILED);
  expect(inline.required).toMatch(/Java und Go/);
  expect(inline.nice).toMatch(/Kafka und Terraform/);
});

test("German JD fixture: DE terms, title synonyms, language requirements, unknown terms", async () => {
  const jd = parseJd(fixture("jd.de.md"), LIMITS);
  const m = jdMatch(jd, "", COMPILED);
  const req = m.required.missing.map((t) => t.term);
  for (const t of ["AI", "machine learning", "Java", "Spring Boot", "Go", "Kubernetes", "Helm", "ArgoCD", "GitLab CI", "React / Angular / Vue", "MongoDB", "Oracle", "distributed systems", "testing", "Scrum"])
    expect(req.includes(t), `${t} in ${req.join(", ")}`).toBeTruthy();
  expect(m.nice.missing.map((t) => t.term)).toEqual(["Kafka", "Terraform"]);
  expect(m.unknown.map((u) => u.term)).toEqual(["SAP"]);
  const langs = languageRequirements(jd.text, COMPILED).map((l) => `${l.lang} ${l.rank} ${l.nice}`);
  expect(langs).toEqual(["German 5 false", "English 5 false"]);
  expect(titleGap("Software Engineer — Platform", jd.role, COMPILED)).toEqual(["ai", "plattform"]);
});

test("title: synonyms and levels", () => {
  for (const [mine, theirs] of [
    ["Software Engineer", "Senior Softwareentwickler (m/w/d)"],
    ["Backend Developer", "Backend-Entwickler (w/m/d)"],
    ["ML Engineer", "Machine Learning Engineer"],
    ["AI Engineer", "KI-Ingenieur (w/m/d)"],
    ["Data Engineer", "Data Engineer Teamlead"],
    ["Full-Stack Engineer", "Fullstack Developer"],
    ["Platform Engineer", "Staff Platform Engineer"],
  ])
    expect(titleGap(mine, theirs, COMPILED), `${mine} vs ${theirs}`).toEqual([]);
  expect(titleGap("Senior Data Scientist", "Data Scientist – NLP (all genders)", COMPILED)).toEqual(["nlp"]);
  expect(titleGap("Backend Engineer", "Frontend Engineer", COMPILED)).toEqual(["frontend"]);
});

test("a pasted JD whose first line is the whole text is matched in well under a second", () => {
  const t0 = performance.now();
  const jd = parseJd(`${"a".repeat(99 * 1024)}\n\n- Python`, LIMITS);
  expect(jd.role.length).toBe(200);
  titleGap("AI Engineer", jd.role, COMPILED);
  titleGap("AI Engineer", "a".repeat(99 * 1024), COMPILED);
  jdMatch(jd, "Python", COMPILED);
  expect(performance.now() - t0 < 1000, `${Math.round(performance.now() - t0)} ms`).toBeTruthy();
});

test("languages: levels per language, nice-to-have, no false requirement from 'a German company'", () => {
  const l = (t: string) => languageRequirements(t, COMPILED).map((x) => `${x.lang}:${x.rank ?? "-"}${x.nice ? "?" : ""}`);
  expect(l("Deutsch C1 und Englisch B2.")).toEqual(["German:5", "English:4"]);
  expect(l("Fluent English; German B1 or better.")).toEqual(["English:5", "German:3"]);
  expect(l("Fluent in German and English.")).toEqual(["German:5", "English:5"]);
  expect(l("Sehr gute Kenntnisse der deutschen Sprache.")).toEqual(["German:5"]);
  expect(l("German is a plus.")).toEqual(["German:-?"]);
  expect(l("We are a German company in Berlin.")).toEqual([]);
});

test("runCheck with a JD: language below the JD level warns; stuffing warns", async () => {
  const r = parseResume(`${BASICS}languages: [{ name: German, level: B1 }, { name: English, level: fluent }]
experience:
  - company: A
    role: R
    start: 2020
    end: present
    bullets:
      - Python service for 40 teams, Python CLI for 12 teams
      - Python SDK used by 3 partners, Python docs, Python tests
`);
  const pdf = textPdf([["Lena Hartmann", "Python", "Education", "Languages"]]);
  const res = await runCheck(r, pdf, { ...OPTIONS, jd: parseJd("## Profile\nPython. Deutsch C1, English C1.", LIMITS) });
  const msgs = res.issues.filter((i) => i.where === "languages" || i.where === "keywords");
  expect(msgs).toContainEqual(expect.objectContaining({ level: "warn", code: "career.check.language_low", params: expect.objectContaining({ lang: "German", level: "C1" }) }));
  expect(msgs).toContainEqual(expect.objectContaining({ level: "info", code: "career.check.language_cefr_missing", params: { lang: "English", have: "fluent" } }));
  expect(msgs).toContainEqual(expect.objectContaining({ level: "warn", code: "career.check.stuffing", params: { term: "Python", count: 5, max: 4 } }));

  const jd = parseJd("## Ihr Profil\n- Abgeschlossenes Studium der Informatik\n- Deutsch C2, Englisch C1", LIMITS);
  const none = (await runCheck(r, pdf, { ...OPTIONS, jd })).issues.find((i) => i.where === "education");
  expect(none?.level).toBe("warn");
  expect(none).toMatchObject({ code: "career.check.education_missing", params: { quote: "Abgeschlossenes Studium der Informatik" } });
  const native = parseResume(`${BASICS}languages: [{ name: Deutsch, level: Muttersprache }, { name: English, level: C1 }]
education: [{ school: Uni Example, degree: B.Sc. Informatik, start: 2014, end: 2018 }]
`);
  const ok = (await runCheck(native, pdf, { ...OPTIONS, jd })).issues.filter((i) => i.where === "education" || i.where === "languages");
  expect(ok.map((i) => i.level), JSON.stringify(ok)).toEqual(["ok", "ok", "ok"]);
  expect(ok[0]).toMatchObject({ code: "career.check.language_native", params: { level: "C2" } });
  expect(ok[2]).toMatchObject({ code: "career.check.education_listed", params: { education: "B.Sc. Informatik, Uni Example" } });
});

test("missingContent: legit renderings are found, a dropped field is reported with its path", () => {
  const r = parseResume(`meta: { lang: de }
basics: { name: Jo Example, title: Engineer, links: [{ label: Site, url: "https://www.example.dev/" }] }
experience:
  - company: Acme GmbH
    role: Senior multi-agent Engineer
    start: 2021-03
    end: present
    bullets: ["Shipped [[GA:green]] in \`Go\` for **12** teams.", "Built an efficient office workflow for the finance team"]
education:
  - { school: Uni Example, degree: B.Sc. Informatik, start: 2014, end: 2018, bullets: [Teaching assistant for databases.] }
sections:
  - experience
  - education
  - title: Readiness
    items: ["[x] On-call rotation documented"]
`);

  const text = `Jo Example
Engineer · example.dev
BERUFSERFAHRUNG Senior multi-
agent Engineer · Acme GmbH 03/2021 – heute
Shipped GA in Go for 12 teams.
Built an eﬃcient oﬃce work­flow for the
2 / 2
finance team
AUSBILDUNG B.Sc. Informatik Uni Example 2014 – 2018
Teaching assistant for databases.
READINESS On-call rotation documented`;
  expect(missingContent(r, text, DAY, LIMITS)).toEqual([]);
  const dropped = missingContent(r, text.replace("Teaching assistant for databases.", "").replace("03/2021 – heute", ""), DAY, LIMITS);
  expect(dropped.map((i) => [i.level, i.where])).toEqual([["error", "experience[0].start"], ["error", "education[0].bullets[0]"]]);
  expect(dropped[1]).toMatchObject({ code: "career.extract.content_missing", params: { text: "Teaching assistant for databases." } });

  expect(!missingContent(r, text, DAY, LIMITS).some((i) => i.where?.startsWith("basics.summary"))).toBeTruthy();
  expect(missingContent(r, text.replace("Teaching assistant for databases.", "Teaching databases"), DAY, LIMITS).length).toBe(1);
});

test("headings: whole words pass; a heading split inside a word is an error even if the word occurs elsewhere", () => {
  expect(headingIn("SKILLS\nLanguages: Go\nLANGUAGES\nEnglish", "Languages").state).toBe("ok");
  expect(headingIn("SKILLS\nLanguages: Go\nL ANGUAGES\nEnglish", "Languages")).toEqual({ state: "split", seen: "L ANGUAGES" });
  expect(headingIn("WAVY T YPOLOGY", "Wavy Typology").state).toBe("split");
  expect(headingIn("this kills it", "Skills").state).toBe("missing");
  expect(headingIn("WEITERBILDUNGSMASSNAHMEN", "Weiterbildungsmaßnahmen").state).toBe("ok");
  const r = parseResume("basics: { name: Jo, title: E }\nlanguages: [{ name: English, level: C1 }]\n");
  expect(parserProblems(r, "Jo\nE\nL ANGUAGES English C1").map((i) => [i.level, i.where])).toEqual([["error", "languages"]]);
});

test("lint: years in the summary vs experience dates", () => {
  const years = (summary: string, extra = "") =>
    lint(parseResume(`basics: { name: T, title: E, phone: "+49 1", workAuth: x, summary: "${summary}" }
experience:
  - { company: A, role: R, start: 2016-01, end: 2018-12, bullets: [x] }
  - { company: B, role: R, start: 2018-06, end: 2022-12, bullets: [x] }
${extra}`), OPTIONS).filter((i) => ["career.lint.years_overstated", "career.lint.years_stale"].includes(i.code)).map((i) => `${i.where}: "${i.params?.text}"`);

  expect(years("Engineer with 7 years in software.")).toEqual([]);
  expect(years("Engineer with 7 years of experience and 3 years shipping LLM products.")).toEqual([]);
  expect(years("Engineer with 5 years in software.")).toEqual(['basics.summary: "5 years"']);
  expect(years("Über 9 Jahre Berufserfahrung.")).toEqual(['basics.summary: "Über 9 Jahre"']);
  expect(years("Engineer with 5+ years of experience.")).toEqual([]);
  expect(years("Engineer with 12 years building data tools.")).toEqual(['basics.summary: "12 years"']);
  expect(years("s", 'approach: [{ title: T, text: "I have 4 years of professional experience." }]')).toEqual(['approach[0].text: "4 years"']);

  expect(lint(parseResume(`basics: { name: T, title: E, summary: "20 years in IT." }\nexperience: [{ company: A, role: R, start: 2020 }]\n`), OPTIONS).filter((i) => ["career.lint.years_overstated", "career.lint.years_stale"].includes(i.code))).toEqual([]);
});

test("lint: a 0000 date (the date sentinel) is an unfinished placeholder; real dates pass", () => {
  const r = parseResume(`${BASICS}experience: [{ company: A, role: R, start: 0000-01, end: 0000-12, bullets: [x] }]
education: [{ school: S, degree: D, start: 2014, end: 2018 }]
certifications: [{ name: C, date: 0000-01 }]
sections: [experience, education, certifications, { title: Work, items: [{ heading: H, date: 0000-01 }] }]
`);
  const zero = lint(r, OPTIONS).filter((i) => i.code === "career.lint.placeholder_date" && String(i.params?.date).startsWith("0000"));
  expect(zero.map((i) => [i.level, i.where])).toEqual([
    ["error", "experience[0].start"],
    ["error", "experience[0].end"],
    ["error", "certifications[0].date"],
    ["error", "sections[3].items[0].start"],
  ]);
  expect(zero[0]).toMatchObject({ code: "career.lint.placeholder_date", params: { date: "0000-01" } });
  expect(!lint(r, OPTIONS).some((i) => ["career.lint.years_overstated", "career.lint.years_stale"].includes(i.code)), "no years claim judged against 0000 dates").toBeTruthy();
});

test("lint: a skill group named like a section heading is info", () => {
  const groups = (g: string) => lint(parseResume(`${BASICS}skills: [{ group: "${g}", items: [Go] }]\nsections: [skills, { title: Tools, items: [x] }]\n`), OPTIONS).filter((i) => i.code === "career.lint.skill_heading");
  expect(groups("Languages")[0]).toMatchObject({ code: "career.lint.skill_heading", params: { group: "Languages", hint: "languages" } });
  expect(groups("Sprachen")[0].level).toBe("info");
  expect(groups("tools").length).toBe(1);
  expect(groups("Programming languages")).toEqual([]);
  expect(groups("Programmiersprachen")).toEqual([]);
});

test("JD degree requirement: Studium / degree / Ausbildung, not Scrum Master or Weiterbildung", () => {
  expect(degreeRequirement("## Ihr Profil\n- Abgeschlossenes Informatikstudium oder vergleichbare Ausbildung", COMPILED)?.nice).toBe(false);
  expect(degreeRequirement("## Requirements\n- A degree in Computer Science or equivalent experience.", COMPILED)).toBeTruthy();
  expect(degreeRequirement("## Nice to have\n- Master's in ML", COMPILED)?.nice).toBe(true);
  expect(degreeRequirement("## Requirements\n- Experience as Scrum Master\n- Clean master data\n## Wir bieten\n- Weiterbildung und Studium", COMPILED)).toBe(undefined);
  expect(levelRank("Muttersprache", COMPILED)?.native).toBe(true);
  expect(levelRank("native (C2)", COMPILED)?.native).toBe(true);
  expect(levelRank("C1", COMPILED)?.native).toBe(false);
});

test("a missing photo is omitted and fails check; sniffed bytes render and pass the image check", async () => {
  const r = parseResume(fixture("sample.de.yaml"));
  r.basics.photo = "portrait.png";
  r.meta.signature = undefined;
  const pdf = textPdf([plainResume(r).split("\n")]);
  for (const theme of listThemes()) expect(!renderResume(r, { theme, today: DAY }).includes("<img"), theme).toBeTruthy();
  for (const photo of [undefined, new Uint8Array([1, 2, 3])]) {
    const res = await runCheck(r, pdf, { ...OPTIONS, images: { photo } });
    expect(res.ok).toBe(false);
    expect(res.lint.find((i) => i.where === "basics.photo")).toMatchObject({ code: "career.check.photo_unreadable", params: { path: "portrait.png" } });
  }
  const photo = imagePng();
  expect(renderResume(r, { today: DAY, images: { photo } }).includes('<img class="photo" src="data:image/png;base64,')).toBeTruthy();
  expect(!(await runCheck(r, pdf, { ...OPTIONS, images: { photo } })).lint.some((i) => i.where === "basics.photo")).toBeTruthy();
});

test("classic keeps the project URL out of the date column", () => {
  const r = parseResume('basics: { name: Test Person, title: Engineer }\nprojects: [{ name: queue, tagline: Embeddable job queue, url: "https://github.com/example/queue" }]\n');
  const html = renderResume(r, { theme: "classic", today: DAY });
  expect(html).toMatch(/<div class="l"><\/div><div class="r"><h3>queue <span class="org">— Embeddable job queue<\/span><\/h3><p class="link"><a href="https:\/\/github\.com\/example\/queue">/);
});

const langIssues = (lang: string, bullets: string[]) =>
  lint(parseResume(`meta: { lang: ${lang} }\n${BASICS}experience:\n  - { company: A, role: R, start: 2020, end: present, bullets: ${JSON.stringify(bullets)} }\n`), OPTIONS).filter((i) => i.where === "meta.lang");

test("a clear language mismatch is an error; weak signals stay a warning or nothing", () => {
  const en = "Built the billing service for the company and cut the cost of the platform by 40% with a cache on the edge of the network";
  const de = "Den Abrechnungsdienst für das Unternehmen aufgebaut und die Kosten der Plattform mit einem Cache um 40% gesenkt, auch bei der Last";
  expect(langIssues("de", [en, `${en} again`])[0]?.level).toBe("error");
  expect(langIssues("en", [de, `${de} noch einmal`])[0]?.level).toBe("error");
  expect(langIssues("en", [en, `${en} again`])).toEqual([]);
  expect(langIssues("de", [de, `${de} noch einmal`])).toEqual([]);

  expect(langIssues("de", [en])[0]?.level).toBe("warn");
  expect(langIssues("de", ["Built the billing service for the company"])).toEqual([]);

  const mixed = [
    "Event-Streaming-Plattform mit Kafka und Kubernetes für die Abrechnung aufgebaut, Infrastructure as Code with Terraform und Migration von Jenkins to GitLab CI",
    "Die Plattform ist auf AWS im Einsatz und wurde mit Go, gRPC und PostgreSQL für 40 Teams in der Produktion betrieben, inklusive On-Call und Code Review",
    "Eine Pipeline für das Deployment der Services in den Clustern entworfen, mit Canary Releases und Rollbacks bei der Überwachung durch Prometheus",
  ];
  expect(langIssues("de", mixed)).toEqual([]);

  const names = [
    "Rebuilt the customer portal for Deutsche Bahn and the Stadtwerke für Energie group, which cut the cost of the platform by 40% for the company",
    "Led the move of the billing system to the cloud with a team of 6, and ran the on-call rota for the services that the company sells to its partners",
  ];
  expect(langIssues("en", names)).toEqual([]);
});

test("placeholders first — only placeholder errors and one info while any is left", () => {
  const nophone = BASICS.replace('phone: "+49 30 000000", ', "");
  const entry = (company: string, start: string) => `${nophone}experience:\n  - { company: "${company}", role: R, start: ${start}, end: present, bullets: ["Did it"] }\nskills: [{ group: G, items: [Cobol] }]\n`;
  const issues = lint(parseResume(entry("⟨Company⟩", "0000-01")), OPTIONS);
  expect(issues.every((i) => i.level === "error" || i.code === "career.lint.placeholders" && typeof i.params?.count === "number"), JSON.stringify(issues)).toBeTruthy();
  expect(issues.filter((i) => i.level === "error").length).toBe(2);
  expect(issues.filter((i) => i.level === "info").length).toBe(1);
  expect(!has(issues, ["career.lint.phone_missing","career.lint.skill_unproven","career.lint.bullet_short"])).toBeTruthy();

  const done = lint(parseResume(entry("Acme", "2020-01")), OPTIONS);
  expect(has(done, "career.lint.phone_missing") && has(done, "career.lint.skill_unproven") && !has(done, ["career.lint.placeholder","career.lint.placeholder_date","career.lint.placeholders","career.letter.placeholders"]), JSON.stringify(done)).toBeTruthy();
});

test("the employer in the JD heading is not a title gap; real gaps still are", () => {
  const mine = "Senior Backend Engineer — Go, Kafka, Kubernetes";

  for (const role of [
    "Senior Backend Engineer (Go) — Northpeak Mobility",
    "Senior Backend Engineer (Go) – Northpeak Mobility",
    "Senior Backend Engineer - Northpeak Mobility",
    "Senior Backend Engineer | Northpeak Mobility",
    "Senior Backend Engineer @ Northpeak",
    "Senior Backend Engineer at Northpeak Mobility",
  ]) {
    expect(titleGap(mine, role, COMPILED), `${role} (company unknown)`).toEqual([]);
    expect(titleGap(mine, role, COMPILED, ["Northpeak Mobility"]), `${role} (company known)`).toEqual([]);
  }

  expect(titleGap("Backend Developer", "Backend-Entwickler Java / Spring Boot (m/w/d) — Stadtwerke Elbtal Digital GmbH", COMPILED)).toEqual(["java", "spring", "boot"]);
  expect(titleGap("Backend Developer", "Backend Engineer GmbH", COMPILED)).toEqual([]);
  expect(titleGap("Backend Engineer", "Northpeak Backend Engineer", COMPILED, ["Northpeak Mobility"])).toEqual([]);

  expect(titleGap("Senior Data Scientist", "Data Scientist – NLP (all genders)", COMPILED)).toEqual(["nlp"]);
  expect(titleGap("Senior Data Scientist", "Data Scientist – NLP (all genders)", COMPILED, ["Northpeak Mobility"])).toEqual(["nlp"]);
  expect(titleGap("Software Engineer", "Software Engineer - Platform Engineer", COMPILED)).toEqual(["platform"]);
  expect(titleGap("Software Engineer", "Software Engineer – Platform", COMPILED, ["Northpeak Mobility"])).toEqual(["platform"]);
  expect(titleGap("Backend Engineer", "Frontend Engineer — Northpeak Mobility", COMPILED, ["Northpeak"])).toEqual(["frontend"]);

  expect(titleGap("Backend Engineer", "Full-Stack Engineer", COMPILED)).toEqual(["fullstack"]);
});

test("runCheck takes the company from target.company and the JD's frontmatter", async () => {
  const pdf = textPdf([["Lena Hartmann", "Python", "Education", "Languages"]]);
  const jd = "# Senior Backend Engineer — Northpeak Mobility\n\n## What you bring\n- Go\n";
  const gap = async (r: ReturnType<typeof parseResume>, text: string) => (await runCheck(r, pdf, { ...OPTIONS, jd: parseJd(text, LIMITS) })).jd!.titleGap;
  const base = "basics: { name: Test Person, title: Senior Backend Engineer }\n";
  expect(await gap(parseResume(`${base}target: { company: Northpeak Mobility }\n`), jd)).toEqual([]);
  expect(await gap(parseResume(base), `---\ncompany: Northpeak Mobility\n---\n${jd}`)).toEqual([]);
  expect(await gap(parseResume(base), jd.replace("Senior Backend Engineer", "Senior Frontend Engineer"))).toEqual(["frontend"]);
});

test("JD terms — architecture terms are in the dictionary; quantities are not 'unknown terms'", () => {
  const jd = parseJd("## What you bring\n- 5+ years of backend engineering, 100k+ users, 24h on-call, 3x faster, 2024, 40%\n- Python and TLA+, C++\n\n## Nice to have\n- Event sourcing / CQRS\n- Domain-Driven Design (DDD), Event-Sourcing, hexagonale Architektur\n", LIMITS);
  const m = jdMatch(jd, "", COMPILED);
  expect(m.unknown.map((u) => u.term)).toEqual(["TLA+"]);

  expect(m.nice.missing.map((t) => t.term)).toEqual(["event sourcing", "event sourcing / CQRS", "DDD", "hexagonal architecture"]);

  const have = findHits("We use Event-Sourcing and CQRS; domain driven design; events are logged.", COMPILED);
  expect([...have.keys()]).toEqual(["event sourcing", "CQRS", "DDD"]);
});

test("schema for address, availability and meta.signature", () => {
  const B = "basics: { name: A B, title: T, location: Berlin";
  expect(errorOf(`${B}, address: [a, b, c] }\n`)).toMatchObject({"code":"career.schema.lines","params":{"what":"address","min":1,"max":2}});
  expect(errorOf(`${B}, address: [] }\n`)).toMatchObject({"code":"career.schema.lines","params":{"what":"address","min":1,"max":2}});
  expect(errorOf(`${B}, availability: "" }\n`)).toMatchObject({"code":"career.schema.empty"});
  expect(errorOf(`meta: { signature: { date: 2026-02-30 } }\n${B} }\n`)).toMatchObject({"code":"career.schema.day_invalid"});
  expect(errorOf(`meta: { signature: { date: 09.10.2026 } }\n${B} }\n`)).toMatchObject({"code":"career.schema.day_format"});
  expect(errorOf(`meta: { signature: { sign: x } }\n${B} }\n`)).toEqual({ code: "career.schema.invalid", path: "meta.signature", params: { keys: "sign" } });
  const r = parseResume(`meta: { signature: {} }\n${B}, address: "Musterstraße 1, 10115 Berlin" }\n`);
  expect(r.basics.address).toEqual(["Musterstraße 1, 10115 Berlin"]);
  expect(r.meta.signature?.date).toBe("auto");
});

test("every theme prints the address instead of the location, the availability once prefixed, and Ort, Datum", async () => {
  const yaml = (lang: string, avail: string) => `meta: { lang: ${lang}, signature: { date: 2026-10-09 } }
basics: { name: Erika Muster, title: Engineer, location: "Köln, Germany", address: ["Beispielweg 7", "50667 Köln"], availability: "${avail}", email: e@example.com }
`;
  for (const theme of listThemes()) {
    const de = (await renderResume(parseResume(yaml("de", "ab 01/2027")), { theme, today: "2027-01-01" }));
    expect(de.includes("Beispielweg 7") && de.includes("50667 Köln"), theme).toBeTruthy();
    expect(!de.includes("Germany"), `${theme}: the address replaces the location`).toBeTruthy();
    expect(de.includes("Verfügbar: ab 01/2027"), theme).toBeTruthy();
    expect(de.includes("Köln, 9. Oktober 2026"), `${theme}: the city of the location, the explicit date`).toBeTruthy();
    expect(!de.includes('class="sign-img"'), `${theme}: no image without signature.image`).toBeTruthy();
    const en = (await renderResume(parseResume(yaml("en", "Available from March 2027")), { today: DAY, theme }));
    expect(en.includes("Available from March 2027") && !en.includes("Available: Available"), theme).toBeTruthy();
    expect(en.includes("Köln, 9 October 2026"), theme).toBeTruthy();
  }

  const auto = parseResume("meta: { signature: { place: Bonn } }\nbasics: { name: A B, title: T }\n");
  expect((await renderResume(auto, { today: "2026-03-01" })).includes("Bonn, 1 March 2026")).toBeTruthy();
});

test("a missing signature is omitted and fails check; completeness includes address, availability and date", async () => {
  const r = parseResume('meta: { lang: de, signature: { image: missing-signature.png, date: 2026-10-09 } }\nbasics: { name: Erika Muster, title: Engineer, location: Hamburg, address: ["Hafenweg 3", "20457 Hamburg"], availability: Kündigungsfrist 3 Monate }\n');
  for (const theme of listThemes()) expect(!renderResume(r, { theme, today: DAY }).includes('<img class="sign-img"'), theme).toBeTruthy();
  const text = plainResume(r) + "Hamburg, 9. Oktober 2026\n";
  const pdf = textPdf([text.trimEnd().split("\n")]);
  const res = await runCheck(r, pdf, OPTIONS);
  expect(res.ok).toBe(false);
  expect(res.lint.find((i) => i.where === "meta.signature.image")).toMatchObject({ code: "career.check.signature_unreadable", params: { path: "missing-signature.png" } });
  expect(res.parser).toEqual([]);
  const gone = missingContent(r, (await extractText(pdf)).replace("Hafenweg 3", "").replace("Kündigungsfrist", "").replace("Hamburg, 9. Oktober 2026", ""), DAY, LIMITS);
  expect(gone.map((i) => i.where).sort()).toEqual(["basics.address[0]", "basics.availability", "meta.signature"]);
  const signature = imagePng();
  expect(renderResume(r, { today: DAY, images: { signature } }).includes('<img class="sign-img" src="data:image/png;base64,')).toBeTruthy();
  expect(!(await runCheck(r, pdf, { ...OPTIONS, images: { signature } })).lint.some((i) => i.where === "meta.signature.image")).toBeTruthy();
  expect((await runCheck(r, pdf, { ...OPTIONS, images: { signature: new Uint8Array([1]) } })).lint.some((i) => i.where === "meta.signature.image")).toBeTruthy();
});

test("numbers keep their unit on the same line in HTML", () => {
  expect(md("p95 fell from 820 ms to **210 ms**, 3 TB, 40 %, 12 k users, 15 h, 5 min, 10 €, 10 EUR, 3 Mio. Euro")).toBe("p95 fell from 820 ms to <strong>210 ms</strong>, 3 TB, 40 %, 12 k users, 15 h, 5 min, 10 €, 10 EUR, 3 Mio. Euro");

  expect(md("5 miles, 3 kinds, 2 Mitarbeiter, 4 mins, 7 hours, Phase 2 and 3")).toBe("5 miles, 3 kinds, 2 Mitarbeiter, 4 mins, 7 hours, Phase 2 and 3");
  expect(md("`820 ms`")).toBe("<code>820 ms</code>");
});

test("alternative and unknown term parameters carry bare terms and separate membership lists", async () => {
  const r = parseResume('basics: { name: Test, title: Engineer }');
  const result = await runCheck(r, textPdf([["Test", "Engineer", "SnowSQL"]]), { ...OPTIONS, jd: parseJd("# Engineer\n## Requirements\nReact or Angular. SnowSQL.", LIMITS) });
  expect(result.issues.find((finding) => finding.code === "career.check.required_missing")).toMatchObject({ params: { terms: "React / Angular", anyOf: "React / Angular" } });
  expect(result.issues.find((finding) => finding.code === "career.check.unknown_terms")).toMatchObject({ params: { terms: "SnowSQL", inResume: "SnowSQL" } });
  const without = await runCheck(r, textPdf([["Test", "Engineer"]]), { ...OPTIONS, jd: parseJd("# Engineer\n## Requirements\nPython. SnowSQL.", LIMITS) });
  expect(without.issues.find((finding) => finding.code === "career.check.required_missing")?.params).toEqual({ terms: "Python" });
  expect(without.issues.find((finding) => finding.code === "career.check.unknown_terms")?.params).toEqual({ terms: "SnowSQL" });
});
