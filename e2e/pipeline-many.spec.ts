import fs from "node:fs";
import path from "node:path";

import { BOARD_DENSITY_COOKIE } from "../src/lib/dashboard/density";

import axe from "axe-core";
import postgres from "postgres";
import { parseDocument } from "yaml";

import { expect, test, type Locator, type Page } from "./fixtures";

declare global {
  interface Window { axe: typeof axe }
}

// Shared config and counts: this spec has its own project in SERIAL_CHAIN.
// The many-card accessibility extension lives here so it uses the same disposable seed.
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

const COMPANY = "Moonfern Board Laboratory";
const OLD_DATE = "2020-12-31T12:00:00.000Z";
const COUNTS = { interested: 50, applied: 20, rejected: 20, withdrawn: 2, offer: 15 } as const;
type SeedStatus = keyof typeof COUNTS;
const seeds: Array<{ id: number; status: SeedStatus; index: number }> = [];
let originalUi: string | undefined;
let uiFile: string;

function database() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !new URL(url).pathname.slice(1).startsWith("jobradar_e2e")) throw new Error("A disposable E2E_DATABASE_URL is required");
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function deleteSeed(sql: ReturnType<typeof database>) {
  await sql`delete from applications where job_id in (select j.id from jobs j join companies c on c.id = j.company_id where c.name_norm = ${COMPANY.toLowerCase()})`;
  await sql`delete from jobs where company_id in (select id from companies where name_norm = ${COMPANY.toLowerCase()})`;
  await sql`delete from companies where name_norm = ${COMPANY.toLowerCase()}`;
}

test.beforeAll(async () => {
  const configDir = process.env.E2E_CONFIG_DIR;
  if (!configDir) throw new Error("E2E_CONFIG_DIR is required");
  uiFile = path.join(configDir, "ui.yaml");
  originalUi = fs.readFileSync(uiFile, "utf8");
  const ui = parseDocument(originalUi);
  ui.setIn(["applications", "hidden_statuses"], ["offer"]);
  fs.writeFileSync(uiFile, ui.toString());
  const sql = database();
  try {
    await deleteSeed(sql);
    const [company] = await sql<{ id: number }[]>`insert into companies (name, name_norm) values (${COMPANY}, ${COMPANY.toLowerCase()}) returning id`;
    for (const status of Object.keys(COUNTS) as SeedStatus[]) {
      for (let index = 0; index < COUNTS[status]; index++) {
        const title = `Moonfern ${status} role ${index + 1}${status === "interested" && index === 0 ? " — research systems for observatories, instruments, simulations and reliable scientific data workflows" : status === "interested" && index === 2 ? " — 面向科研观测站的可靠数据处理系统研发工程师，负责复杂中文界面与跨团队协作流程" : ""}`;
        const [job] = await sql<{ id: number }[]>`insert into jobs (company_id, title, title_norm, description, german_level_required) values (${company!.id}, ${title}, ${title.toLowerCase()}, 'Fictional board layout fixture.', 'none') returning id`;
        const id = job!.id;
        seeds.push({ id, status, index });
        const [application] = await sql<{ id: number }[]>`insert into applications (job_id, status, status_changed_at) values (${id}, ${status}, now() - interval '1 day') returning id`;
        // One applied card deliberately lacks an applied event, for the subsequent date coverage.
        if (status !== "applied" || index !== 0) await sql`insert into application_events (application_id, to_status, at) values (${application!.id}, ${status}, now() - interval '1 day')`;
        // Source cards sort below existing target cards, so a landing must reveal the bottom, not reset to the top.
        const rank = (status === "interested" ? 60 : 95) - index;
        await sql`insert into scores (job_id, filter_result, provider, model, score, ai_score, rank_value, scored_at) values (${id}, 'passed', 'test', 'fixture', ${rank}, ${rank}, ${rank}, now())`;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test.beforeEach(async () => {
  const sql = database();
  try {
    for (const status of Object.keys(COUNTS) as SeedStatus[]) {
      const ids = seeds.filter((seed) => seed.status === status).map((seed) => seed.id);
      await sql`update applications set status = ${status}, status_changed_at = now() - interval '1 day' where job_id = any(${ids}::bigint[])`;
      await sql`delete from application_events where application_id in (select id from applications where job_id = any(${ids}::bigint[]))`;
      const withEvents = status === "applied" ? ids.filter((id) => id !== seedId("applied", 0)) : ids;
      await sql`insert into application_events (application_id, to_status, at) select id, status, status_changed_at from applications where job_id = any(${withEvents}::bigint[])`;
    }
    await sql`update applications set status_changed_at = ${OLD_DATE}::timestamptz where job_id = ${seedId("applied", 1)}`;
    await sql`update application_events set at = ${OLD_DATE}::timestamptz where application_id in (select id from applications where job_id = ${seedId("applied", 1)})`;
    await sql`update applications set next_action = 'Prepare the complete research proposal and supporting evidence for the observatory review', next_action_at = '2026-12-24T12:00:00Z'::timestamptz where job_id = ${seedId("interested", 0)}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test.afterAll(async () => {
  if (originalUi !== undefined) fs.writeFileSync(uiFile, originalUi);
  const sql = database();
  try { await deleteSeed(sql); } finally { await sql.end({ timeout: 5 }); }
});

const column = (page: Page, status: string) => page.locator(`[data-testid="board-column"][data-column="${status}"]`);
const scroll = (page: Page, status: string) => column(page, status).getByTestId("column-scroll");
const card = (page: Page, id: number) => page.getByTestId("board").locator(`[data-job-id="${id}"]`);
const seedId = (status: SeedStatus, index: number) => seeds.find((seed) => seed.status === status && seed.index === index)!.id;
const live = (page: Page) => page.locator('[id^="DndLiveRegion"]');

async function open(page: Page) {
  await page.goto(`/pipeline?q=${encodeURIComponent(COMPANY)}`);
  await expect(scroll(page, "interested").getByTestId("pipeline-card")).toHaveCount(50);
  await expect(column(page, "offer")).toHaveAttribute("data-hidden-column", "collapsed");
  await page.waitForLoadState("networkidle");
}

async function overflow(node: Locator, axis: "x" | "y" = "y") {
  expect(await node.evaluate((el, axis) => axis === "x" ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight, axis)).toBe(true);
}

async function inside(node: Locator, viewport: Locator) {
  await expect.poll(async () => {
    const a = await node.boundingBox();
    const b = await viewport.evaluate((el) => {
      const board = el.closest<HTMLElement>('[data-testid="board"]')!;
      const rect = el.getBoundingClientRect(), outer = board.getBoundingClientRect();
      return {
        left: Math.max(rect.left + el.clientLeft, outer.left + board.clientLeft, 0),
        top: Math.max(rect.top + el.clientTop, outer.top + board.clientTop, 0),
        right: Math.min(rect.left + el.clientLeft + el.clientWidth, outer.left + board.clientLeft + board.clientWidth, innerWidth),
        bottom: Math.min(rect.top + el.clientTop + el.clientHeight, outer.top + board.clientTop + board.clientHeight, innerHeight),
      };
    });
    return Boolean(a && a.x >= b.left - 1 && a.y >= b.top - 1 && a.x + a.width <= b.right + 1 && a.y + a.height <= b.bottom + 1);
  }).toBe(true);
}

async function box(node: Locator) {
  const bounds = await node.boundingBox();
  if (!bounds) throw new Error("Expected a mounted board element");
  return bounds;
}

/** Real mouse input only: callers reveal the source, and edge hovering reveals offscreen targets. */
async function pickUp(page: Page, source: Locator, offsetY = 12) {
  const from = await box(source);
  await page.mouse.move(from.x + from.width / 2, from.y + offsetY);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 24, from.y + offsetY + 16, { steps: 4 });
  await expect(page.getByTestId("board")).toHaveAttribute("data-dragging", "true");
}

async function hoverVisible(page: Page, target: Locator, edge: "middle" | "bottom" = "middle") {
  const point = await target.evaluate((node, edge) => {
    const board = node.closest('[data-testid="board"]')!;
    const scroll = node.closest("[data-column-scroll]")!;
    const a = node.getBoundingClientRect(), b = board.getBoundingClientRect(), c = scroll.getBoundingClientRect();
    const left = Math.max(a.left, b.left, c.left), right = Math.min(a.right, b.right, c.right);
    const top = Math.max(a.top, b.top, c.top), bottom = Math.min(a.bottom, b.bottom, c.bottom);
    if (right <= left || bottom <= top) throw new Error("Drop zone is outside the scroll viewport");
    return { x: (left + right) / 2, y: edge === "bottom" ? bottom - 4 : (top + bottom) / 2 };
  }, edge);
  await page.mouse.move(point.x, point.y, { steps: 12 });
}

async function saved(page: Page, id: number, status: string) {
  await expect(page.getByText(`${COMPANY} → ${status}`).first()).toBeVisible();
  await expect(card(page, id)).toBeVisible();
}

async function pickUpKeyboard(page: Page, id: number) {
  await overflow(scroll(page, "interested"));
  await card(page, id).getByTestId("card-handle").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("drop-interested")).toHaveAttribute("data-over", "true");
}

async function arrowTo(page: Page, status: string) {
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId(`drop-${status}`)).toHaveAttribute("data-over", "true");
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
  test(`fits ${viewport.width} × ${viewport.height}; only the selected column scrolls to its last card`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page);
    const board = page.getByTestId("board");
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    expect(await board.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    expect((await box(board)).y + (await box(board)).height).toBeLessThanOrEqual(viewport.height + 1);
    const heights = await page.getByTestId("board-column").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    const heads = await page.getByTestId("column-count").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    const otherTop = await scroll(page, "applied").evaluate((el) => el.scrollTop);
    const source = scroll(page, "interested");
    await overflow(source);
    await source.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await inside(source.getByTestId("pipeline-card").last(), source);
    expect(await board.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    expect(await scroll(page, "applied").evaluate((el) => el.scrollTop)).toBe(otherTop);
    expect(await page.getByTestId("column-count").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top))).toEqual(heads);
  });
}

test("the toolbar reaches both ends without scrolling the page", async ({ page }) => {
  await open(page);
  const board = page.getByTestId("board"), next = page.getByTestId("board-next"), prev = page.getByTestId("board-prev");
  const waitForScrollSettled = async () => {
    // Let scroll snapping and its navigation-state update finish before checking the next button state.
    await expect.poll(() => board.evaluate(async (el) => {
      const before = el.scrollLeft;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return el.scrollLeft === before;
    })).toBe(true);
  };
  await overflow(board, "x");
  await expect(next).toBeInViewport();
  await expect(prev).toBeDisabled();
  for (let i = 0; i < 10 && await next.isEnabled(); i++) {
    await next.click();
    await waitForScrollSettled();
  }
  await expect(next).toBeDisabled();
  await inside(column(page, "ended"), board);
  expect((await box(board)).y + (await box(board)).height).toBeLessThanOrEqual(900);
  for (let i = 0; i < 10 && await prev.isEnabled(); i++) {
    await prev.click();
    await waitForScrollSettled();
  }
  await expect(prev).toBeDisabled();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("short screens keep the configured board floor and scroll only the heading and toolbar in main", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await open(page);
  await overflow(scroll(page, "interested"));
  const board = page.getByTestId("board"), main = page.locator("main");
  await overflow(main);
  const dimensions = await board.evaluate((el) => ({ actual: el.getBoundingClientRect().height, minimum: Number.parseFloat(getComputedStyle(el).minHeight) }));
  expect(dimensions.actual).toBeCloseTo(dimensions.minimum, 0);
  const allowed = (await box(page.locator("[data-fit-viewport] > header"))).height + (await box(page.getByRole("search", { name: "筛选申请" }))).height;
  expect(await main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(allowed + 1);
  const fullHeight = await main.evaluate((el) => el.scrollHeight);
  const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await main.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.getByTestId("pipeline-search").fill("Moonfern interested role 50");
  await expect(scroll(page, "interested").getByTestId("pipeline-card")).toHaveCount(1);
  expect(await main.evaluate((el) => el.scrollHeight)).toBe(fullHeight);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(documentHeight);
  expect(documentHeight).toBeLessThanOrEqual(561);
});

test("ended groups share one scroll area; an expanded hidden column scrolls without becoming a drop target", async ({ page }) => {
  await open(page);
  const board = page.getByTestId("board");
  await overflow(board, "x");
  await board.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  const before = (await box(board)).height;
  await page.getByTestId("ended-toggle").click();
  const ended = scroll(page, "ended");
  await expect(ended).toHaveCount(1);
  expect(await board.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await expect(ended.locator('[data-testid^="drop-"]')).toHaveCount(3);
  await overflow(ended);
  await ended.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await inside(card(page, seedId("withdrawn", 1)), ended);
  await page.getByTestId("hidden-toggle-offer").click();
  const offer = scroll(page, "offer");
  expect(await board.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await overflow(offer);
  await offer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByTestId("drop-offer")).toHaveCount(0);
  await inside(offer.getByTestId("pipeline-card").last(), offer);
  expect((await box(board)).height).toBe(before);
});

test("mouse drag from the source bottom lands visibly in a scrolled target and persists", async ({ page }) => {
  await open(page);
  const source = scroll(page, "interested"), target = scroll(page, "applied");
  await overflow(source);
  await overflow(target);
  await source.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await target.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
  const id = seedId("interested", 49);
  await inside(card(page, id), source);
  await pickUp(page, card(page, id));
  await hoverVisible(page, page.getByTestId("drop-applied"));
  await page.mouse.up();
  await saved(page, id, "已申请");
  await inside(card(page, id), target);
  expect(await target.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.reload();
  await expect(column(page, "applied").locator(`[data-job-id="${id}"]`)).toHaveCount(1);
});

test("a menu move into a partly clipped column stays visible after horizontal snapping settles", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const board = page.getByTestId("board"), source = scroll(page, "interested");
  await overflow(board, "x");
  await overflow(source);
  const scrollLeft = await board.evaluate((el) => el.scrollLeft);
  expect(scrollLeft).toBe(0);
  // Keep the initial snap position and find the status column clipped by the board's right edge.
  const right = await board.evaluate((el) => el.getBoundingClientRect().left + el.clientLeft + el.clientWidth);
  const clipped = await board.locator('[data-testid="board-column"]:not([data-hidden-column]):not([data-column="ended"])').evaluateAll((nodes, right) => nodes.flatMap((node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.left < right && bounds.right > right ? [node.getAttribute("data-column")!] : [];
  }), right);
  expect(clipped).toHaveLength(1);
  const targetStatus = clipped[0]!, target = scroll(page, targetStatus);
  await source.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const id = seedId("interested", 49);
  await inside(column(page, "interested"), board);
  await inside(card(page, id), source);
  expect(await board.evaluate((el) => el.scrollLeft)).toBe(scrollLeft);
  await card(page, id).getByTestId("card-status").click();
  expect(await board.evaluate((el) => el.scrollLeft)).toBe(scrollLeft);
  const move = page.getByTestId(`card-move-${targetStatus}`);
  const targetLabel = (await move.innerText()).trim();
  await move.click();
  await saved(page, id, targetLabel);
  const landed = target.locator(`[data-job-id="${id}"]`);
  await inside(landed, target);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await inside(landed, target);
});

test("hovering at a target's bottom and the board's right edge auto-scrolls, then withdrawn expands on drop", async ({ page }) => {
  await open(page);
  const target = scroll(page, "applied"), board = page.getByTestId("board");
  await overflow(target);
  await overflow(board, "x");
  await pickUp(page, card(page, seedId("interested", 0)));
  await hoverVisible(page, page.getByTestId("drop-applied"), "bottom");
  await expect.poll(() => target.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  const bounds = await box(board);
  await page.mouse.move(bounds.x + bounds.width - 4, bounds.y + bounds.height / 2, { steps: 12 });
  await expect.poll(() => board.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50);
  await expect.poll(async () => {
    const zone = await box(page.getByTestId("drop-withdrawn"));
    return zone.x + zone.width <= bounds.x + bounds.width;
  }).toBe(true);
  await hoverVisible(page, page.getByTestId("drop-withdrawn"));
  await page.mouse.up();
  await saved(page, seedId("interested", 0), "我放弃");
  await expect(page.getByTestId("ended-toggle")).toHaveAttribute("aria-expanded", "true");
  await overflow(scroll(page, "ended"));
  await inside(card(page, seedId("interested", 0)), scroll(page, "ended"));
});

for (const edge of ["top", "bottom"] as const) {
  test(`pointer outside the ${edge} of the visible drop area never changes status`, async ({ page }) => {
    await open(page);
    const id = seedId("interested", 0);
    await pickUp(page, card(page, id), edge === "bottom" ? (await box(card(page, id))).height / 2 : 12);
    const target = await box(scroll(page, "applied"));
    const board = await box(page.getByTestId("board"));
    await page.mouse.move(target.x + target.width / 2, edge === "top" ? target.y - 1 : board.y + board.height + 1, { steps: 12 });
    const overlay = await box(page.getByTestId("card-lifted"));
    expect(Math.min(overlay.y + overlay.height, target.y + target.height) - Math.max(overlay.y, target.y)).toBeGreaterThan(0);
    await expect(page.locator('[data-over="true"]')).toHaveCount(0);
    await expect(live(page)).toContainText("不在任何列上");
    await page.mouse.up();
    await expect(column(page, "interested").locator(`[data-job-id="${id}"]`)).toHaveCount(1);
    await page.reload();
    await expect(column(page, "interested").locator(`[data-job-id="${id}"]`)).toHaveCount(1);
  });
}

test("keyboard chooses rejected for a tall card in the collapsed offscreen ended column and returns focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await page.getByTestId("pipeline-density").getByRole("radio", { name: "舒适" }).click();
  const board = page.getByTestId("board"), id = seedId("interested", 0);
  await overflow(board, "x");
  expect((await box(card(page, id))).height).toBeGreaterThan(200);
  expect((await box(column(page, "ended"))).x).toBeGreaterThan((await box(board)).x + (await box(board)).width);
  await pickUpKeyboard(page, id);
  for (const status of ["preparing", "applied", "interviewing", "rejected"]) await arrowTo(page, status);
  await expect(live(page)).toContainText(`${COMPANY} 在“被拒”列上方`);
  await page.keyboard.press("Space");
  await saved(page, id, "被拒");
  await expect(page.getByTestId("ended-toggle")).toHaveAttribute("aria-expanded", "true");
  await inside(card(page, id), scroll(page, "ended"));
  await expect(card(page, id).getByTestId("card-handle")).toBeFocused();
  await page.reload();
  await page.getByTestId("ended-toggle").click();
  await expect(page.getByTestId("drop-rejected").locator(`[data-job-id="${id}"]`)).toHaveCount(1);
});

test("keyboard moving backwards from the scrolled source leaves its scroll position unchanged", async ({ page }) => {
  await open(page);
  const source = scroll(page, "interested");
  await overflow(source);
  await source.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await pickUpKeyboard(page, seedId("interested", 49));
  const before = await source.evaluate((el) => el.scrollTop);
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("drop-new")).toHaveAttribute("data-over", "true");
  expect(await source.evaluate((el) => el.scrollTop)).toBe(before);
  await page.keyboard.press("Escape");
});

test("keyboard keeps a visible target's scrollTop and reaches withdrawn below an overflowing rejected group", async ({ page }) => {
  await open(page);
  const board = page.getByTestId("board"), target = scroll(page, "applied");
  await overflow(target);
  await target.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
  const before = await target.evaluate((el) => el.scrollTop);
  const id = seedId("interested", 1);
  await pickUpKeyboard(page, id);
  await arrowTo(page, "preparing");
  await arrowTo(page, "applied");
  expect(await target.evaluate((el) => el.scrollTop)).toBe(before);
  await page.keyboard.press("Escape");
  await overflow(board, "x");
  await board.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.getByTestId("ended-toggle").click();
  const ended = scroll(page, "ended");
  await overflow(ended);
  expect((await box(page.getByTestId("drop-withdrawn"))).y).toBeGreaterThan((await box(ended)).y + (await box(ended)).height);
  await board.evaluate((el) => { el.scrollLeft = 0; });
  await pickUpKeyboard(page, id);
  for (const status of ["preparing", "applied", "interviewing", "rejected", "withdrawn"]) await arrowTo(page, status);
  expect(await ended.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(live(page)).toContainText(`${COMPANY} 在“我放弃”列上方`);
  await page.keyboard.press("Space");
  await saved(page, id, "我放弃");
  await inside(card(page, id), ended);
  await expect(card(page, id).getByTestId("card-handle")).toBeFocused();
});

test("phone layout starts at the first populated column, scrolls vertically, and retains the menu and drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("board-prev")).toBeHidden();
  await expect(page.getByTestId("board-next")).toBeHidden();
  const source = scroll(page, "interested");
  await overflow(source);
  await overflow(page.getByTestId("board"), "x");
  expect(await page.getByTestId("board").evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await inside(column(page, "interested"), page.getByTestId("board"));
  await source.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const id = seedId("interested", 49);
  await inside(card(page, id), source);
  await card(page, id).getByTestId("card-open").click();
  await expect(page.getByTestId("card-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await card(page, id).getByTestId("card-status").click();
  await page.getByTestId("card-move-applied").click();
  await saved(page, id, "已申请");
  await inside(card(page, id), scroll(page, "applied"));
});

test("many-card accessibility: named scroll regions, axe, and Tab reaches the final card", async ({ page }) => {
  await open(page);
  await page.getByTestId("ended-toggle").click();
  await page.getByTestId("hidden-toggle-offer").click();
  await expect(page.getByTestId("board")).toHaveAccessibleName(/\S/);
  for (const region of await page.getByTestId("column-scroll").all()) await expect(region).toHaveAccessibleName(/\S/);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }));
  });
  expect(violations).toEqual([]);
  const source = scroll(page, "interested");
  await overflow(source);
  // Position focus on the scroll region; reaching the last card uses only Tab, never focus() on that card.
  await source.focus();
  await source.evaluate((el) => { el.scrollTop = 0; });
  const last = source.getByTestId("pipeline-card").last();
  const target = last.getByTestId("card-open");
  for (let i = 0; i < 200 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  expect(await source.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await inside(last, source);
});

test("moving into applied and Undo restore both recorded dates", async ({ page }) => {
  await open(page);
  const id = seedId("interested", 15);
  const source = card(page, id);
  await source.scrollIntoViewIfNeeded();
  const original = await source.getByTestId("card-dates").innerHTML();
  expect(await source.getByTestId("card-applied-date").count()).toBe(0);
  await source.getByTestId("card-status").click();
  await page.getByTestId("card-move-applied").click();
  await saved(page, id, "已申请");
  await expect(source.getByTestId("card-applied-date").locator("time")).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);
  const appliedIso = await source.getByTestId("card-applied-date").locator("time").getAttribute("datetime");
  await expect(source.getByTestId("card-status-date").locator("time")).toHaveAttribute("datetime", appliedIso!);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(column(page, "interested").locator(`[data-job-id="${id}"]`)).toHaveCount(1);
  await expect.poll(() => source.getByTestId("card-dates").innerHTML()).toBe(original);
  await page.reload();
  await expect.poll(() => card(page, id).getByTestId("card-dates").innerHTML()).toBe(original);
});

test("density defaults to compact and the first HTML response respects the remembered browser choice", async ({ page, context }) => {
  await context.clearCookies({ name: BOARD_DENSITY_COOKIE });
  await open(page);
  await expect(page.getByTestId("board")).toHaveAttribute("data-density", "compact");
  await page.getByTestId("pipeline-density").getByRole("radio", { name: "舒适" }).click();
  await expect(page.getByTestId("board")).toHaveAttribute("data-density", "comfortable");
  const cookie = (await context.cookies()).find((cookie) => cookie.name === BOARD_DENSITY_COOKIE);
  expect(cookie).toMatchObject({ value: "comfortable", path: "/", sameSite: "Lax" });
  const response = await page.reload();
  expect(await response!.text()).toMatch(/<div[^>]*data-testid="board"[^>]*data-density="comfortable"/);
  await expect(page.getByTestId("board")).toHaveAttribute("data-density", "comfortable");
  await page.goto("/jobs");
  const navigation = await page.goto(`/pipeline?q=${encodeURIComponent(COMPANY)}`);
  expect(await navigation!.text()).toMatch(/<div[^>]*data-testid="board"[^>]*data-density="comfortable"/);
  await expect(page.getByTestId("pipeline-density").getByRole("radio", { name: "舒适" })).toBeChecked();
});

test("compact clamps configured lines and keeps long, Chinese and cross-year content apart", async ({ page }) => {
  await open(page);
  await page.getByTestId("pipeline-density").getByRole("radio", { name: "紧凑" }).click();
  const defaults = process.env.E2E_DEFAULTS_DIR;
  if (!defaults) throw new Error("E2E_DEFAULTS_DIR is required");
  const config = parseDocument(fs.readFileSync(path.join(defaults, "pipeline-board.yaml"), "utf8"));
  const titleLines = Number(config.getIn(["compact", "title_lines"]));
  const nextLines = Number(config.getIn(["compact", "next_action_lines"]));
  const long = card(page, seedId("interested", 0));
  for (const entry of [long, card(page, seedId("interested", 2)), card(page, seedId("applied", 1))]) {
    await entry.scrollIntoViewIfNeeded();
    const title = entry.getByTestId("card-open");
    expect(await title.getAttribute("title")).toBe(await title.innerText());
    expect(await title.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe(String(titleLines));
    const measurements = await title.evaluate((el) => ({ height: el.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight) }));
    expect(measurements.height).toBeLessThanOrEqual(measurements.lineHeight * titleLines + 1);
    const overlaps = await entry.evaluate((el) => {
      const selectors = ['[data-testid="card-open"]', '[data-testid="card-handle"]', '[data-testid="card-dates"]', '[data-slot="card-salary"]', '[data-slot="card-next"]'];
      const boxes = selectors.flatMap((selector) => { const node = el.querySelector(selector); return node ? [node.getBoundingClientRect()] : []; });
      return boxes.some((a, i) => boxes.slice(i + 1).some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
    });
    expect(overlaps).toBe(false);
  }
  const next = long.locator('[data-slot="card-next"] b');
  expect(await next.getAttribute("title")).toBe(await next.innerText());
  expect(await next.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe(String(nextLines));
  await expect(card(page, seedId("applied", 1)).getByTestId("card-applied-date")).toContainText("2020");
  await expect(card(page, seedId("applied", 0)).getByTestId("card-applied-date").locator("dd")).toHaveText("未记录");
  await long.getByTestId("card-open").click();
  await expect(page.getByTestId("card-drawer")).toContainText(await long.getByTestId("card-open").getAttribute("title") ?? "");
});

test("phone density toggle retains multi-card scrolling, full text and dates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  for (const [label, density] of [["舒适", "comfortable"], ["紧凑", "compact"]] as const) {
    await page.getByTestId("pipeline-density").getByRole("radio", { name: label }).click();
    await expect(page.getByTestId("board")).toHaveAttribute("data-density", density);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const source = scroll(page, "interested");
    await overflow(source);
    await source.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = card(page, seedId("interested", 49));
    await inside(last, source);
    await expect(last.getByTestId("card-dates")).toBeVisible();
    await last.getByTestId("card-open").click();
    await expect(page.getByTestId("card-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
