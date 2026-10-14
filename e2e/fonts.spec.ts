import { expect, test, type CDPSession, type Page } from "./fixtures";

/**
 * The self-hosted fonts: every subset the families cover renders in its own family (never a fallback such as Arial),
 * only the Latin files are preloaded, and Chinese text is set in Noto Sans SC from a few on-demand shards.
 *
 * The probes are the test's own elements, appended to a rendered page, each holding only characters that belong to one
 * subset (the unicode-ranges of the font CSS). The family a probe resolves to is read from Chromium itself
 * (CSS.getPlatformFontsForNode) after the browser has loaded the faces the text needs (display: swap would otherwise
 * show the fallback for a moment). A wrong family name or unicode-range in the font rules fails here, and so does a
 * Plex Mono weight served from another weight's file (each probe checks the PostScript name of the instance it got).
 */

interface Probe {
  id: string;
  /** a utility class of the app: font-sans (Archivo), font-display (Archivo Black, weight 900), font-mono (IBM Plex Mono) */
  className: string;
  /** an inline font-weight (none: the class decides) */
  weight?: number;
  text: string;
  /** the family name inside the font file Chromium must use for every glyph (a variable font adds its instance, e.g. "Archivo SemiBold") */
  family: RegExp;
  /** the font file of this subset (and weight) that must have been requested */
  file: RegExp;
  /** the PostScript name of the font instance every glyph must come from (the static Plex files: one per weight) */
  postScriptName?: string;
}

const ARCHIVO = /^Archivo(?! Black)\b/;
const PLEX = /^IBM Plex Mono\b/;
const PLEX_POSTSCRIPT: Record<number, string> = { 400: "IBMPlexMono-Regular", 500: "IBMPlexMono-Medium", 600: "IBMPlexMono-SemiBold", 700: "IBMPlexMono-Bold" };

// Each text uses characters the subset file really has (IBM Plex Mono's cyrillic-ext covers Kazakh / Tatar letters such
// as Ғ and Ә, not historic ones such as ѣ). NFC text only: a decomposed "ệ" is "e" plus combining marks, which belong to
// other subsets. Every weight the app uses is probed: each Plex weight is its own file.
const PLEX_TEXT: Record<string, string> = { latin: "Mono 0123", "latin-ext": "Łódź", cyrillic: "Привет", "cyrillic-ext": "ҒғӘә", vietnamese: "ệạ" };
const PROBES: Probe[] = [
  ...[400, 800].flatMap((weight): Probe[] => [
    { id: `sans-latin-ext-${weight}`, className: "font-sans", weight, text: "Wrocław Łódź", family: ARCHIVO, file: /archivo-latin-ext-wght-normal/ },
    { id: `sans-vietnamese-${weight}`, className: "font-sans", weight, text: "Nguyễn ệạ", family: ARCHIVO, file: /archivo-vietnamese-wght-normal/ },
  ]),
  { id: "display-latin-ext", className: "font-display", text: "Łódź", family: /^Archivo Black\b/, file: /archivo-black-latin-ext-400-normal/ },
  ...Object.entries(PLEX_TEXT).flatMap(([subset, text]) =>
    [400, 500, 600, 700].map((weight): Probe => ({
      id: `mono-${subset}-${weight}`,
      className: "font-mono",
      weight,
      text,
      family: PLEX,
      file: subset === "latin" ? new RegExp(`ibm_plex_mono_latin_${weight}_normal`) : new RegExp(`ibm-plex-mono-${subset}-${weight}-normal`),
      postScriptName: PLEX_POSTSCRIPT[weight],
    })),
  ),
];

/**
 * Appends the probes to the page and waits until the faces their text needs are loaded. Every web font face that was
 * tried must have loaded. The fallback faces (local("Arial") with metric overrides, named "... Fallback") may fail:
 * Linux systems usually have no Arial (fontconfig's Liberation Sans stand-in does not answer to local("Arial")), and
 * the browser then skips the face. document.fonts.load rejects when any face it tried fails, hence allSettled.
 */
async function addProbes(page: Page, probes: Array<Pick<Probe, "id" | "className" | "text" | "weight">>): Promise<void> {
  const failed = await page.evaluate(async (list) => {
    const box = document.createElement("div");
    for (const probe of list) {
      const el = document.createElement("div");
      el.dataset.fontProbe = probe.id;
      el.className = probe.className;
      if (probe.weight !== undefined) el.style.fontWeight = String(probe.weight);
      el.textContent = probe.text;
      box.append(el);
    }
    document.body.append(box);
    await Promise.allSettled(
      list.map((probe) => {
        const el = document.querySelector<HTMLElement>(`[data-font-probe="${probe.id}"]`);
        return el ? document.fonts.load(getComputedStyle(el).font, probe.text) : Promise.resolve([]);
      }),
    );
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === "error").map((face) => `${face.family.replace(/"/g, "")} ${face.weight} ${face.unicodeRange}`);
  }, probes);
  expect(failed.filter((face) => !/^[^,]+ Fallback /.test(face)), "font faces that failed to load").toEqual([]);
}

async function platformFonts(cdp: CDPSession, id: string): Promise<Array<{ familyName: string; postScriptName: string; isCustomFont: boolean }>> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-font-probe="${id}"]` });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts.map((font) => ({ familyName: font.familyName, postScriptName: font.postScriptName, isCustomFont: font.isCustomFont }));
}

async function openWithCdp(page: Page, path: string): Promise<{ cdp: CDPSession; fontRequests: string[] }> {
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".woff2")) fontRequests.push(request.url());
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  return { cdp, fontRequests };
}

test("every subset of the Latin families renders in its own family and fetches its own file", async ({ page }) => {
  const { cdp, fontRequests } = await openWithCdp(page, "/jobs");
  await addProbes(page, PROBES.map(({ id, className, weight, text }) => ({ id, className, weight, text })));
  for (const probe of PROBES) {
    const fonts = await platformFonts(cdp, probe.id);
    expect(fonts.length, probe.id).toBeGreaterThan(0);
    for (const font of fonts) {
      expect({ probe: probe.id, ...font }).toEqual({
        probe: probe.id,
        familyName: expect.stringMatching(probe.family),
        postScriptName: probe.postScriptName ?? expect.any(String),
        isCustomFont: true,
      });
    }
    expect(fontRequests.some((url) => probe.file.test(url)), `${probe.id}: ${probe.file}`).toBe(true);
  }
});

test("only the Latin subset files are preloaded", async ({ page }) => {
  await page.goto("/");
  const preloads = await page.locator('link[rel="preload"][as="font"]').evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  // Archivo, Archivo Black and the four weights of IBM Plex Mono
  expect(preloads).toHaveLength(6);
  for (const href of preloads) {
    expect(href).toMatch(/(archivo|archivo_black|ibm_plex_mono)_latin_/);
    expect(href).not.toMatch(/latin_ext|vietnamese|cyrillic|noto/);
  }
});

test("Chinese text is set in Noto Sans SC from a few shards, and display type uses its weight 900", async ({ page }) => {
  // the run's language is Chinese: the page itself already has Chinese text
  const { cdp, fontRequests } = await openWithCdp(page, "/");
  await addProbes(page, [
    { id: "cjk-sans", className: "font-sans", text: "岗位正文" },
    { id: "cjk-display", className: "font-display", text: "今日岗位" },
  ]);
  for (const id of ["cjk-sans", "cjk-display"]) {
    const fonts = await platformFonts(cdp, id);
    expect(fonts.length, id).toBeGreaterThan(0);
    for (const font of fonts) {
      expect({ probe: id, ...font }).toEqual({ probe: id, familyName: expect.stringMatching(/^Noto Sans SC\b/), postScriptName: expect.any(String), isCustomFont: true });
    }
  }
  // the weight is not in CDP's answer: the display probe asks for 900 and the loaded Noto face covers it
  const display = page.locator('[data-font-probe="cjk-display"]');
  await expect(display).toHaveCSS("font-weight", "900");
  const notoWeights = await page.evaluate(() =>
    [...document.fonts].filter((face) => face.family.replace(/"/g, "") === "Noto Sans SC Variable" && face.status === "loaded").map((face) => face.weight),
  );
  expect(notoWeights.length).toBeGreaterThan(0);
  for (const weight of notoWeights) expect(weight).toBe("100 900");
  // the font is split into about a hundred files: a page fetches only the ones its characters need
  const shards = fontRequests.filter((url) => /noto-sans-sc-/.test(url));
  expect(shards.length).toBeGreaterThan(0);
  expect(shards.length).toBeLessThan(40);
});
