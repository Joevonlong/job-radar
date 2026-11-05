// @vitest-environment node
import { describe, expect, test } from "vitest";
import { CareerEngineError, listThemes, parseResume, renderResume, themeProblem } from "../../../src/lib/career/engine";
import { fontFaceCss, fontFaceCssFromTable, type FontFace } from "../../../src/lib/career/engine/fonts";
import { dataUrl, imageType } from "../../../src/lib/career/engine/images";
import { style as baseStyle } from "../../../src/lib/career/engine/themes/base";
import { THEMES } from "../../../src/lib/career/engine/themes";
import { DAY, resumeFixture } from "./helpers/fixtures";
import { imagePng } from "./helpers/images";

const NAMES = ["minimal", "band", "classic", "compact", "split"];
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'";
const CASES = NAMES.flatMap((theme) => [
  { theme, sample: "sample.en.yaml", doc: "resume" as const },
  { theme, sample: "sample.de.yaml", doc: "resume" as const },
  { theme, sample: "letter.de.yaml", doc: "letter" as const },
]);

describe("self-contained rendering", () => {
  test.each(CASES)("$theme / $sample / $doc", ({ theme, sample, doc }) => {
    const r = resumeFixture(sample);
    r.basics.photo = "portrait.png";
    r.meta.signature = { date: "auto", image: "signature.png" };
    const png = imagePng();
    for (const images of [undefined, { photo: new Uint8Array([1]), signature: new Uint8Array([2]) }, { photo: png, signature: png }]) {
      const html = renderResume(r, { theme, doc, today: DAY, images });
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
      expect(html).not.toMatch(/<script\b|<link\b/i);
      for (const match of html.matchAll(/\bsrc\s*=\s*["']([^"']*)["']/gi)) expect(match[1].startsWith("data:"), match[1]).toBe(true);
      for (const match of html.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)) expect((match[1] ?? match[2] ?? match[3]).startsWith("data:"), match[0]).toBe(true);
      const withoutAnchorHrefs = html.replace(/(<a\b[^>]*\bhref=)["'][^"']*["']/gi, "$1\"\"");
      expect(withoutAnchorHrefs).not.toMatch(/https?:/i);
      const sources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
      if (images?.photo === png) {
        expect(sources).toHaveLength(doc === "letter" ? 1 : 2);
        expect(sources.every((src) => src === dataUrl(png))).toBe(true);
      } else expect(sources).toEqual([]);
      if (doc === "letter") expect(html).not.toContain('<img class="photo"');
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
      expect(styles).toEqual([fontFaceCss(THEMES[theme].template.fonts), baseStyle, THEMES[theme].style, `:root { --accent: ${r.meta.accent}; }`]);
    }
  });

  test("bytes only render images named by the document", () => {
    const r = parseResume("basics: { name: Test Person, title: Engineer }\n");
    const png = imagePng();
    expect(renderResume(r, { today: DAY, images: { photo: png, signature: png } })).not.toContain("<img");
  });

  test("a letter without content reports its stable error code", () => {
    expect(() => renderResume(parseResume("basics: { name: Test Person, title: Engineer }"), { today: DAY, doc: "letter" }))
      .toThrow(new CareerEngineError("career.letter.missing"));
  });

  test("image sniffing uses bytes and data URLs preserve their complete payload", () => {
    const png = imagePng();
    expect(imageType(png)).toBe("image/png");
    expect(imageType(new Uint8Array([255, 216, 255]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("RIFF0000WEBP"))).toBe("image/webp");
    expect(imageType(new Uint8Array())).toBeUndefined();
    expect(dataUrl(new Uint8Array([1, 2, 3]))).toBeUndefined();
    const large = new Uint8Array(131_072);
    large.set(png);
    const encoded = dataUrl(large)!.split(",")[1];
    expect(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))).toEqual(large);
  });
});

test("theme names have a fixed registry order and unknown names report a code", () => {
  expect(listThemes()).toEqual(["minimal", "band", "classic", "compact", "split"]);
  for (const name of NAMES) {
    expect(Object.hasOwn(THEMES, name)).toBe(true);
    expect(themeProblem(name)).toBeUndefined();
  }
  const problem = { code: "career.theme.unknown", params: { name: "missing", available: NAMES.join(", ") } };
  expect(themeProblem("missing")).toEqual(problem);
  for (const render of [
    () => parseResume("meta: { theme: missing }\nbasics: { name: Test Person, title: Engineer }"),
    () => renderResume(resumeFixture("sample.en.yaml"), { today: DAY, theme: "missing" }),
    () => renderResume({ ...resumeFixture("sample.en.yaml"), meta: { ...resumeFixture("sample.en.yaml").meta, theme: "missing" } }, { today: DAY }),
  ]) {
    try {
      render();
      expect.unreachable("expected an unknown theme");
    } catch (error) {
      expect(error).toBeInstanceOf(CareerEngineError);
      expect(error).toMatchObject({ ...problem, message: problem.code });
    }
  }
  for (const name of ["__proto__", "constructor", "../theme"]) expect(themeProblem(name)?.code).toBe("career.theme.unknown");
});

test("font CSS emits matching table rows in reference order, including each subset", () => {
  const row: FontFace = { family: "Inter", weight: 400, subset: "latin", unicodeRange: "U+0000-00FF", woff2Base64: "AA==" };
  const expected = "@font-face { font-family: 'Inter'; font-style: normal; font-display: block; font-weight: 400; src: url(data:font/woff2;base64,AA==) format('woff2'); unicode-range: U+0000-00FF; }";
  expect(fontFaceCssFromTable([{ family: "Inter", weight: 400 }], [row])).toBe(expected);
  expect(fontFaceCssFromTable([{ family: "Inter", weight: 500 }], [row])).toBe("");
  expect(fontFaceCssFromTable([{ family: "Newsreader", weight: 400 }], [row])).toBe("");
  const extended = { ...row, subset: "latin-ext", unicodeRange: "U+0100-02FF" };
  expect(fontFaceCssFromTable([{ family: "Inter", weight: 400 }], [row, extended])).toBe(`${expected}\n${expected.replace("U+0000-00FF", "U+0100-02FF")}`);
  expect(fontFaceCssFromTable([{ family: "Newsreader", weight: 500 }, { family: "Inter", weight: 400 }], [row, { ...row, family: "Newsreader", weight: 500 }])).toBe(`${expected.replace("Inter", "Newsreader").replace("weight: 400", "weight: 500")}\n${expected}`);
});
