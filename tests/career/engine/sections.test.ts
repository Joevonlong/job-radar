// @vitest-environment node
import { issuesOf, OPTIONS, resumeFromYaml as parseResume, DAY, fixture } from "./helpers/fixtures";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { readingOrderProblem } from "../../../src/lib/career/engine/extract";
import { lint } from "../../../src/lib/career/engine/lint";
import { md } from "../../../src/lib/career/engine/md";
import { listThemes, renderResume } from "../../../src/lib/career/engine/render";
import { BUILTINS, type CustomSection, headingHints, headingOf, parseTag, plainText, resolveSections } from "../../../src/lib/career/engine/sections";

const BASICS = "basics: { name: Test Person, title: Engineer }\n";
const errorOf = (yaml: string) => issuesOf(BASICS + yaml)[0];

test("listing all 8 built-ins in default order renders the same as no `sections`", async () => {
  for (const file of ["sample.en.yaml", "sample.de.yaml"]) {
    const doc = parse(fixture(file));
    const plain = parseResume(JSON.stringify(doc));
    const listed = parseResume(JSON.stringify({ ...doc, sections: [...BUILTINS] }));
    for (const theme of listThemes())
      expect((await renderResume(listed, { today: DAY, theme })), `${file} / ${theme}`).toBe((await renderResume(plain, { today: DAY, theme })));
  }
});

test("readingOrderProblem: per-section chains on synthetic text", () => {
  const r = parseResume(
    BASICS +
      `experience:
  - { company: A, role: Role One, start: 2020, bullets: [First **bold** bullet] }
sections:
  - title: Extras
    items:
      - heading: Alpha
        bullets: [Alpha point]
        tags: ["Go:blue"]
  - title: Checks
    items:
      - "[x] Done thing"
  - title: Stack
    items:
      - { label: Stack, items: [Go, Rust] }
  - experience
`,
  );

  const ok = "Extras Alpha Alpha point Go Checks Done thing Stack Stack: Go, Rust Experience Role One First bold bullet";
  expect(readingOrderProblem(r, ok)).toBe(null);
  expect(readingOrderProblem(r, ok.replace("Alpha point", "Zzz"))).toEqual({ code: "career.extract.order_missing", params: { name: "Extras", text: "alpha point…" } });
  expect(readingOrderProblem(r, "Extras Alpha point Alpha Go Checks Done thing Stack Role One First bold bullet")).toEqual({ code: "career.extract.order_wrong", params: { name: "Extras", text: "alpha point…" } });

  const hidden = parseResume(BASICS + "experience:\n  - { company: A, role: Role One, start: 2020, bullets: [x1] }\nsections: [summary]\n");
  expect(readingOrderProblem(hidden, "nothing here")).toBe(null);
});

test("readingOrderProblem ignores spaces pdf.js inserts around inline labels, and checks group items", () => {
  const r = parseResume(
    BASICS +
      `experience:
  - company: A
    role: Role One
    start: 2020
    bullets: ["Shipped [[GA:green]], then scaled to [[3 regions]].", "[[One]][[Two]] side by side"]
sections:
  - experience
  - title: Stack
    items:
      - { label: Stack, items: [Go, Rust] }
`,
  );
  const text = "Role One Shipped GA , then scaled to 3 regions . One Two side by side Stack Stack: Go, Rust";
  expect(readingOrderProblem(r, text)).toBe(null);
  expect(readingOrderProblem(r, text.replace("Go, Rust", "Go"))).toEqual({ code: "career.extract.order_missing", params: { name: "Stack", text: "go, rust…" } });
  expect(readingOrderProblem(r, text.replace("Stack Stack:", "Stack:").replace("Go, Rust", "Rust Go"))).toMatchObject({ code: "career.extract.order_missing", params: { name: "Stack" } });
});

test("meta.colors is quiet or accent; only accent marks the body", async () => {
  const err = errorOf("meta: { colors: loud }\n");
  expect(err).toMatchObject({"code":"career.schema.invalid","path":"meta.colors"});
  expect(err).toMatchObject({"code":"career.schema.invalid","params":{"values":"quiet, accent"}});
  const body = async (y: string) => (await renderResume(parseResume(BASICS + y), { today: DAY })).match(/<body[^>]*>/)![0];
  expect(!(await body("")).includes("data-colors")).toBeTruthy();
  expect(!(await body("meta: { colors: quiet }\n")).includes("data-colors")).toBeTruthy();
  expect((await body("meta: { colors: accent }\n")).includes('data-colors="accent"')).toBeTruthy();
});

test("unknown theme reports a stable code without a module path", () => {
  expect(errorOf("meta: { theme: minimall }\n")).toMatchObject({ code: "career.theme.unknown", path: "meta.theme", params: { name: "minimall" } });
  expect(() => renderResume(parseResume(BASICS), { theme: "../src", today: DAY })).toThrow(/career\.theme\.unknown/);
});

test("lint: custom section bullets, paths, unlisted built-ins", () => {
  const long = "x".repeat(201);
  const r = parseResume(
    BASICS +
      `summary: ignored
experience:
  - { company: A, role: R, start: 2020, bullets: [one 1] }
projects:
  - { name: P, bullets: [one 1] }
sections:
  - experience
  - title: T
    items:
      - ${long}
  - title: C
    items:
      - "[ ] ${long}"
  - title: E
    items:
      - heading: H
        bullets: [a, b, c, d, e, ${long}]
`,
  );
  const issues = lint(r, OPTIONS);
  const at = (where: string) => issues.filter((i) => i.where === where);
  expect(at("sections[1].items[0]").length).toBe(1);
  expect(at("sections[2].items[0]").length).toBe(1);
  expect(at("sections[3].items[0].bullets[5]")[0]?.level).toBe("warn");
  expect(at("sections[3].items[0]")[0]).toMatchObject({ code: "career.lint.bullets_many", params: { count: 6 } });
  expect(at("sections[3].items[0]").length).toBe(1);
  for (const i of issues) expect(i.where, i.where).toMatch(/^[a-zA-Z]+(\[\d+\]|\.[a-zA-Z]+)*$|^[A-Z]/);
  expect(issues.some((i) => i.where === "sections" && i.code === "career.lint.section_hidden" && i.params?.name === "projects")).toBeTruthy();
  expect(!issues.some((i) => i.code === "career.lint.section_hidden" && i.params?.name === "experience")).toBeTruthy();

  expect(!issues.some((i) => i.where === "bullets")).toBeTruthy();

  expect(!lint(parseResume(BASICS + "summary: s\nprojects:\n  - { name: P, bullets: [one 1] }\n"), OPTIONS).some((i) => i.where === "sections")).toBeTruthy();
});

test("md renders inline markup safely", () => {
  expect(md("cut by **63%** with `x<y` and [docs](https://a.io/?q=1&r=2)")).toBe('cut by <strong>63%</strong> with <code>x&lt;y</code> and <a href="https://a.io/?q=1&amp;r=2">docs</a>');
  expect(md("[**bold link**](mailto:a@b.co) and **`c`**")).toBe('<a href="mailto:a@b.co"><strong>bold link</strong></a> and <strong><code>c</code></strong>');
  expect(md('<b> & "q" \'s\'')).toBe("&lt;b&gt; &amp; &quot;q&quot; &#39;s&#39;");
});

test("md labels: colours, escaping, edge cases", () => {
  expect(md("[[Go]] and [[GA:green]]")).toBe('<span class="tag tag-accent">Go</span> and <span class="tag tag-green">GA</span>');
  expect(md("[[<b>:green]]")).toBe('<span class="tag tag-green">&lt;b&gt;</span>');
  expect(!md("[[x:purple]]").includes("tag-purple")).toBeTruthy();
  expect(md("[[x:purple]]")).toBe('<span class="tag tag-accent">x:purple</span>');
  expect(md("[[Ratio 3:1]]")).toBe('<span class="tag tag-accent">Ratio 3:1</span>');
  expect(md("[[a:b:green]]")).toBe('<span class="tag tag-green">a:b</span>');
  expect(md("[[x:Green]]")).toBe('<span class="tag tag-accent">x:Green</span>');
  expect(md("`[[x]]`")).toBe("<code>[[x]]</code>");
  expect(md("[[]] [[:green]]")).toBe("[[]] [[:green]]");
  expect(md("**[[hot:red]]**")).toBe('<strong><span class="tag tag-red">hot</span></strong>');
  expect(md("[[a]] and [b](https://u.io)")).toBe('<span class="tag tag-accent">a</span> and <a href="https://u.io">b</a>');
});

test("md only links web, mail and phone URLs", () => {
  expect(md("[x](javascript:alert(1))")).toBe("x)");
  expect(!md("[x](JavaScript:alert`1`)").includes("<a")).toBeTruthy();
  expect(!md("[x](data:text/html;base64,AAAA)").includes("<a")).toBeTruthy();
  expect(!md("[x](//evil.example)").includes("<a")).toBeTruthy();
  expect(md("[call](tel:+10000000)")).toBe('<a href="tel:+10000000">call</a>');
  expect(md('[x](https://a.io/"onclick="1)')).toBe('<a href="https://a.io/&quot;onclick=&quot;1">x</a>');
});

test("plainText strips inline markup", () => {
  expect(plainText("**Led** [[GA:green]] with `go` via [docs](https://u.io)")).toBe("Led GA with go via docs");
  expect(plainText("[x] done")).toBe("done");
  expect(plainText("[ ] open **item**")).toBe("open item");
  expect(plainText("[[]] stays")).toBe("[[]] stays");
});

test("parseTag splits at the last colon", () => {
  expect(parseTag("LLM")).toEqual({ text: "LLM", color: "accent" });
  expect(parseTag("Evals:green")).toEqual({ text: "Evals", color: "green" });
  expect(parseTag("a:b:green")).toEqual({ text: "a:b", color: "green" });
  expect(parseTag("x:purple")).toEqual({ text: "x:purple", color: "accent" });
  expect(parseTag("Ratio 3:1")).toEqual({ text: "Ratio 3:1", color: "accent" });
  expect(parseTag("x:Green")).toEqual({ text: "x:Green", color: "accent" });
});

test("unknown and duplicate built-in names", () => {
  const unknown = errorOf("sections:\n  - summary\n  - expirience\n");
  expect(unknown).toMatchObject({"code":"career.schema.builtin_unknown","params":{"name":"expirience"}});
  expect(unknown).toMatchObject({"code":"career.schema.builtin_unknown","params":{"available":expect.stringMatching("^summary, approach, experience")}});
  expect(unknown).toMatchObject({"path":"sections.1"});
  const dup = errorOf("sections:\n  - summary\n  - experience\n  - summary\n");
  expect(dup).toMatchObject({"code":"career.schema.section_duplicate","params":{"name":"summary"}});
  expect(dup).toMatchObject({"path":"sections.2"});
});

test("{ use, title } gives a built-in its own heading; mistakes name the position", () => {
  const r = parseResume(BASICS + "sections:\n  - summary\n  - { use: experience, title: \" Work Experience \" }\n");
  expect(r.sections).toEqual(["summary", { use: "experience", title: "Work Experience" }]);
  expect(resolveSections(r).map((s) => s.kind === "builtin" && s.name)).toEqual(["summary", "experience"]);
  expect(headingOf(r, "experience")).toBe("Work Experience");
  expect(headingOf(r, "skills")).toBe("Skills");
  expect(errorOf("sections:\n  - { use: experience }\n")).toMatchObject({"code":"career.schema.invalid","path":"sections.0.title"});
  expect(errorOf("sections:\n  - { use: experience, title: \" \" }\n")).toMatchObject({"code":"career.schema.empty","path":"sections.0.title"});
  expect(errorOf("sections:\n  - { use: experiance, title: X }\n")).toMatchObject({"code":"career.schema.rename_unknown","params":{"name":"experiance"},"path":"sections.0.use"});
  expect(errorOf("sections:\n  - { use: experience, title: X, items: [a] }\n")).toMatchObject({"code":"career.schema.invalid","params":{"keys":"items"},"path":"sections.0"});
  expect(errorOf("sections:\n  - experience\n  - { use: experience, title: X }\n")).toMatchObject({"code":"career.schema.section_duplicate","params":{"name":"experience"},"path":"sections.1"});
});

test("heading hints say what each built-in prints, its place, or why it is not printed", () => {
  const yaml = BASICS.replace("}", ", summary: Hi }") + "skills: [{ group: G, items: [a] }]\nsections:\n  - summary\n  - title: X\n    items: [a]\n  - { use: skills, title: Tools }\n  - projects\n";
  const h = headingHints(parseResume(yaml));
  expect(h.summary).toEqual({ heading: "Profile", own: false, state: "shown", order: 1 });
  expect(h.skills).toEqual({ heading: "Tools", own: true, state: "shown", order: 3 });
  expect(h.projects.state).toBe("empty");
  expect(h.experience.state).toBe("unlisted");
  const split = headingHints(parseResume(yaml.replace("basics:", "meta: { theme: split }\nbasics:")));
  expect(split.summary.state).toBe("lead");
  expect(split.skills.order).toBe(2);
});

test("unknown field in a custom section", () => {
  const msg = errorOf("sections:\n  - title: X\n    itmes: [a]\n    items: [b]\n");
  expect(msg).toMatchObject({"code":"career.schema.invalid","params":{"keys":"itmes"}});
  expect(msg).toMatchObject({"path":"sections.0"});
});

test("YAML traps get a quoting hint with the item path", () => {
  const list = errorOf("sections:\n  - title: X\n    items:\n      - a\n      - [x]\n");
  expect(list).toMatchObject({"code":"career.schema.item_list"});
  expect(list).toMatchObject({"path":"sections.0.items.1"});
  const nested = errorOf("sections:\n  - title: X\n    items:\n      - [[GA]]\n");
  expect(nested).toMatchObject({"code":"career.schema.item_list"});
  expect(nested).toMatchObject({"path":"sections.0.items.0"});
  const single = errorOf("sections:\n  - title: X\n    items:\n      - ok\n      - Led migration: cut 30%\n");
  expect(single).toMatchObject({"code":"career.schema.item_mapping"});
  expect(single).toMatchObject({"path":"sections.0.items.1"});
});

test("unquoted `- [ ] todo` and `- [[GA]] shipped` are YAML errors; the message says to quote", () => {
  for (const item of ["[ ] todo", "[x] done", "[[GA]] shipped"]) {
    const msg = errorOf(`sections:\n  - title: X\n    items:\n      - ${item}\n`);
    expect(msg).toMatchObject({"code":"career.schema.yaml_invalid","params":{"hint":"quote_item"}});
  }
  expect(errorOf("a: [1\nb: 2\n")).not.toMatchObject({ code: "career.schema.yaml_invalid", params: { hint: "quote_item" } });
});

test("mixed kinds, layout and item combinations", () => {
  const mixed = errorOf("sections:\n  - title: X\n    items:\n      - a\n      - { label: L, items: [b] }\n");
  expect(mixed).toMatchObject({"code":"career.schema.mixed_kinds"});
  expect(mixed).toMatchObject({"path":"sections.0.items.1"});
  expect(parseResume(BASICS + 'sections:\n  - title: X\n    items:\n      - a\n      - "[x] b"\n').sections?.length).toBe(1);

  const grid = errorOf("sections:\n  - title: X\n    layout: grid\n    items:\n      - { heading: H }\n");
  expect(grid).toMatchObject({"code":"career.schema.layout_kind","params":{"layout":"grid","kind":"entry"}});
  expect(grid).toMatchObject({"path":"sections.0.items.0"});
  const gridMix = errorOf("sections:\n  - title: X\n    layout: grid\n    items:\n      - a\n      - { label: L, items: [b] }\n");
  expect(gridMix).toMatchObject({"code":"career.schema.mixed_kinds"});
  expect(gridMix).toMatchObject({"path":"sections.0.items.1"});
  expect(parseResume(BASICS + 'sections:\n  - title: X\n    layout: grid\n    items:\n      - a\n      - "[x] b"\n').sections?.length).toBe(1);
  const tags = errorOf("sections:\n  - title: X\n    layout: tags\n    items:\n      - a\n      - { text: t }\n");
  expect(tags).toMatchObject({"code":"career.schema.layout_kind","params":{"layout":"tags","kind":"text"}});
  expect(tags).toMatchObject({"path":"sections.0.items.1"});
});

test("columns needs grid", () => {
  const msg = errorOf("sections:\n  - title: X\n    columns: 3\n    items: [a]\n");
  expect(msg).toMatchObject({"code":"career.schema.columns_layout"});
  expect(msg).toMatchObject({"path":"sections.0.columns"});
});

test("date rules", () => {
  const both = errorOf("sections:\n  - title: X\n    items:\n      - { heading: H, date: 2025-04, start: 2024 }\n");
  expect(both).toMatchObject({"code":"career.schema.date_range"});
  expect(both).toMatchObject({"path":"sections.0.items.0.date"});
  expect(errorOf("sections:\n  - title: X\n    items:\n      - { heading: H, date: present }\n")).toMatchObject({"code":"career.schema.date_present"});
  const end = errorOf("sections:\n  - title: X\n    items:\n      - { heading: H, end: 2024 }\n");
  expect(end).toMatchObject({"code":"career.schema.start_missing"});
  expect(end).toMatchObject({"path":"sections.0.items.0.end"});
});

test("empty content is rejected, with paths", () => {
  const bad = (items: string, code: string, at: string) => {
    const msg = errorOf(`sections:\n  - title: X\n${items}`);
    expect(msg.code).toBe(code);
    expect(msg.path).toBe(at.replace(/\[(\d+)\]/g, ".$1"));
  };
  bad('    items:\n      - "[x] "\n', "career.schema.check_empty", "sections[0].items[0]");
  bad('    items: ["a", ""]\n', "career.schema.empty", "sections[0].items[1].text");
  bad('    layout: tags\n    items: ["a", ""]\n', "career.schema.empty", "sections[0].items[1].text");
  bad("    items:\n      - { label: L, items: [] }\n", "career.schema.items_empty", "sections[0].items[0].items");
  bad('    items:\n      - { label: L, items: ["a", ""] }\n', "career.schema.empty", "sections[0].items[0].items[1]");
  bad('    items:\n      - { heading: H, tags: [""] }\n', "career.schema.empty", "sections[0].items[0].tags[0]");
  bad('    items:\n      - { heading: H, bullets: [""] }\n', "career.schema.empty", "sections[0].items[0].bullets[0]");
});

test("entry end must not be before start (compared on the shared prefix)", () => {
  const e = (start: string, end: string) => `sections:\n  - title: X\n    items:\n      - { heading: H, start: ${start}, end: ${end} }\n`;
  const msg = errorOf(e("2025", "2023-05"));
  expect(msg).toMatchObject({"code":"career.schema.end_before_start","params":{"end":"2023-05","start":"2025"}});
  expect(msg).toMatchObject({"path":"sections.0.items.0.end"});
  expect(errorOf(e("2024-06", "2024-02"))).toMatchObject({"code":"career.schema.end_before_start"});
  for (const [s, en] of [["2023", "2023-05"], ["2023-05", "2023"], ["2020", "present"], ["2023-01", "2023-01"]]) expect(parseResume(BASICS + e(s, en))).toBeTruthy();
});

test("URL fields only link http(s)/mailto/tel; meta.accent cannot break out of <style>", async () => {
  const y = `basics: { name: A, title: B, links: [{ label: x, url: "javascript:alert(1)" }, { label: y, url: "https://ok.example/p" }] }
experience: [{ company: C, role: R, start: 2020, url: "javascript:alert(2)" }]
projects: [{ name: P, url: "JavaScript:alert(3)" }]
`;
  for (const theme of ["minimal", "split"]) {
    const html = renderResume(parseResume(y), { today: DAY, theme });
    expect(!/href="javascript/i.test(html), theme).toBeTruthy();
    expect(html.includes('href="https://ok.example/p"'), theme).toBeTruthy();
    expect(html.includes("javascript:alert(1)"), theme).toBeTruthy();
  }

  for (const accent of ["red}</style><script>alert(1)</script>", 'red;"x', "a\\b", "a\nb", "url(http://track.example/b)", "rgb(url(x))", "var(--x)", "#12345"])
    expect(errorOf(`meta: { accent: ${JSON.stringify(accent)} }\n`), accent).toMatchObject({"code":"career.schema.accent_invalid"});
  for (const accent of ["#2f54eb", "#25e", "#2f54ebcc", "rgb(47 84 235)", "rgba(47, 84, 235, .9)", "hsl(220deg 80% 55% / 0.9)", "oklch(0.55 0.2 260)", "teal"])
    expect(parseResume(BASICS + `meta: { accent: "${accent}" }\n`), accent).toBeTruthy();
});

test("items are recognised by shape and normalised", () => {
  const r = parseResume(
    BASICS +
      `sections:
  - title: 2025
    layout: tags
    items: [3, "Evals:green", "[x] literal"]
  - title: Mixed
    columns: 3
    layout: grid
    items:
      - { label: L, items: [a, 5] }
      - { label: M, items: [b] }
  - title: Entries
    items:
      - { heading: H, date: 2025-04, tags: [3, "a:b:green"], bullets: [one] }
      - { heading: G, start: 2020, end: present }
`,
  );
  const [tags, grid, entries] = r.sections as CustomSection[];
  expect(tags.title).toBe("2025");
  expect(tags.items).toEqual([
    { kind: "tag", tag: { text: "3", color: "accent" } },
    { kind: "tag", tag: { text: "Evals", color: "green" } },
    { kind: "tag", tag: { text: "[x] literal", color: "accent" } },
  ]);
  expect([grid.layout, grid.columns, grid.side]).toEqual(["grid", 3, "main"]);
  expect(grid.items[0]).toEqual({ kind: "group", label: "L", items: ["a", "5"] });
  expect(entries.items[0]).toEqual({ kind: "entry", heading: "H", start: "2025-04", bullets: ["one"], tags: [{ text: "3", color: "accent" }, { text: "a:b", color: "green" }] });
  expect(entries.items[1]).toEqual({ kind: "entry", heading: "G", start: "2020", end: "present", bullets: [], tags: [] });
  expect([entries.layout, entries.columns]).toEqual(["list", 2]);
});

test("`sections` absent, null or empty means the default order", () => {
  for (const y of ["", "sections:\n", "sections: []\n"]) {
    const r = parseResume(BASICS + y);
    expect(resolveSections(r).map((s) => s.kind === "builtin" && s.name)).toEqual([...BUILTINS]);
  }
});

test("resolveSections keeps order and indexes custom sections by position", () => {
  const r = parseResume(BASICS + "sections:\n  - experience\n  - title: Extra\n    items: [a]\n  - summary\n");
  const s = resolveSections(r);
  expect(s.map((x) => (x.kind === "builtin" ? x.name : x.title))).toEqual(["experience", "Extra", "summary"]);
  expect(s[1].kind === "custom" && s[1].index).toBe(1);
});

test("sections fixture parses", async () => {
  const r = parseResume(fixture("sections.en.yaml"));
  expect(resolveSections(r).some((s) => s.kind === "custom" && s.side === "aside")).toBeTruthy();
});
