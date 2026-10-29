import { expect, test, type Locator, type Page } from "./fixtures";

/**
 * Pipeline board on the seeded e2e database. Fictional seed applications used here:
 *  - Quillfeather Labs: interested for 9 days (overdue: notify.yaml allows 7)
 *  - Tidewater Robotics: applied 16 days ago (overdue: notify.yaml allows 14)
 *  - Fernweh Software: preparing (the card the tests move; every test puts it back)
 *  - Saltmarsh Cloud: archived (ignored), Aurelia Dynamics: rejected
 * The UI is Chinese by default.
 */

test.describe.configure({ mode: "serial" });

const FERNWEH = "Fernweh Software";

/** The toast appears when the server has stored the change. */
const saved = (page: Page, company: string, status: string): Locator => page.getByText(`${company} → ${status}`).first();

/** The lines of the drawer's timeline (a terminal log, oldest first: the newest change is the last line). */
const timelineLines = (page: Page): Locator => page.locator('[data-testid="timeline"] [role="log"] > span');

const card = (page: Page, company: string): Locator => page.getByTestId("pipeline-card").filter({ hasText: company });
const column = (page: Page, status: string): Locator => page.locator(`[data-testid="board-column"][data-column="${status}"]`);

async function open(page: Page, path = "/pipeline") {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("board")).toBeVisible();
}

/** The "move to…" menu of a card: open it and pick a status. */
async function moveWithMenu(cardLocator: Locator, status: string) {
  await cardLocator.getByTestId("card-status").click();
  await cardLocator.page().getByTestId(`card-move-${status}`).click();
}

/**
 * Mouse drag from the top of a card to the middle of a drop zone, in small steps (dnd-kit's mouse sensor
 * needs real moves). The zone is looked up once the drag has started: the ended column's zones only appear then.
 */
async function drag(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  if (!from) throw new Error("drag: card not visible");
  await page.mouse.move(from.x + from.width / 2, from.y + 14);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 24, from.y + 36, { steps: 4 });
  await target.waitFor({ state: "visible" });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error("drag: drop zone not visible");
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 40), { steps: 14 });
  await page.mouse.up();
}

async function openDrawer(page: Page, company: string) {
  await card(page, company).getByTestId("card-open").click();
  await expect(page.getByTestId("card-drawer")).toBeVisible();
}

test.describe("desktop 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("equal columns: the board scrolls inside its own container, the page never does", async ({ page }) => {
    await open(page);
    await expect(page.locator('[data-testid="board-column"]')).toHaveCount(7);
    // seven readable columns do not fit next to the sidebar at 1440: the board scrolls, the page does not
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const widths = await page.getByTestId("board-column").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const board = page.getByTestId("board");
    expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // the last column is reachable by scrolling the board
    await column(page, "ended").scrollIntoViewIfNeeded();
    const [boardBox, last] = await Promise.all([board.boundingBox(), column(page, "ended").boundingBox()]);
    expect(boardBox && last && last.x + last.width <= boardBox.x + boardBox.width + 1).toBe(true);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1700, height: 1000 } });

  test("seeded applications sit in their columns, overdue ones are marked", async ({ page }) => {
    await open(page);
    await expect(column(page, "interested").getByTestId("pipeline-card").filter({ hasText: "Quillfeather Labs" })).toBeVisible();
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(column(page, "applied").getByTestId("pipeline-card").filter({ hasText: "Tidewater Robotics" })).toBeVisible();
    await expect(card(page, "Quillfeather Labs").getByTestId("card-overdue")).toContainText("感兴趣 9 天未申请");
    await expect(card(page, "Tidewater Robotics").getByTestId("card-overdue")).toContainText("已申请 16 天没有回音");
    await expect(card(page, FERNWEH).getByTestId("card-overdue")).toHaveCount(0);
    // the thresholds in the summary line come from notify.yaml
    await expect(page.getByTestId("pipeline-summary")).toContainText("感兴趣超过 7 天、已申请超过 14 天");
    // ended jobs share one collapsed column; the count is there, the cards appear on expanding
    await expect(column(page, "ended").getByTestId("column-count")).toHaveText(/^[2-9]/);
    await expect(column(page, "ended").getByTestId("pipeline-card")).toHaveCount(0);
    await page.getByTestId("ended-toggle").click();
    await expect(column(page, "ended").getByTestId("pipeline-card").filter({ hasText: "Saltmarsh Cloud" })).toBeVisible();
    await expect(column(page, "ended").getByTestId("pipeline-card").filter({ hasText: "Aurelia Dynamics" })).toBeVisible();
  });

  test("dragging a card changes its status; it survives a reload and shows in the timeline", async ({ page }) => {
    await open(page);
    // the card's history is shared with the other tests of this file (and with retries): count relative to what it has now
    await openDrawer(page, FERNWEH);
    const eventsBefore = await timelineLines(page).count();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-drawer")).toBeHidden();
    await drag(page, card(page, FERNWEH), page.getByTestId("drop-applied"));
    await expect(column(page, "applied").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(saved(page, FERNWEH, "已申请")).toBeVisible();
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toHaveCount(0);

    await page.reload();
    await expect(column(page, "applied").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();

    await openDrawer(page, FERNWEH);
    const events = timelineLines(page);
    await expect(events.last()).toContainText("准备中 → 已申请");
    await expect(events).toHaveCount(eventsBefore + 1); // this move

    // put it back with the status menu on the card (also one event)
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-drawer")).toBeHidden();
    await moveWithMenu(card(page, FERNWEH), "preparing");
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(saved(page, FERNWEH, "准备中")).toBeVisible();
    await page.reload();
    await openDrawer(page, FERNWEH);
    await expect(timelineLines(page).last()).toContainText("已申请 → 准备中");
    await expect(timelineLines(page)).toHaveCount(eventsBefore + 2); // the move and the move back
  });

  test("the toast after a drag has an Undo that restores the previous status; the card shows its clock and the columns their share", async ({ page }) => {
    await open(page);
    // the overdue bar carries the days and the notify.yaml threshold (7 days for interested)
    const meter = card(page, "Quillfeather Labs").getByRole("meter", { name: /感兴趣 9 天未申请/ });
    // scale = the threshold (7 days), value capped at it, the overrun is in the value text
    await expect(meter).toHaveAttribute("aria-valuemax", "7");
    await expect(meter).toHaveAttribute("aria-valuenow", "7");
    await expect(meter).toHaveAttribute("aria-valuetext", "超时 2 天（阈值 7 天）");
    await expect(column(page, "interested").getByRole("meter", { name: /占流程/ })).toBeVisible();
    // the three end outcomes are counted without expanding
    await expect(column(page, "ended").getByRole("meter", { name: /被拒/ })).toBeVisible();

    await drag(page, card(page, FERNWEH), page.getByTestId("drop-applied"));
    await expect(column(page, "applied").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(saved(page, FERNWEH, "已申请")).toBeVisible();
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(page.getByText(`已撤销：${FERNWEH} → 准备中`)).toBeVisible();
    await page.reload();
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
  });

  test("a card moves with the keyboard: Tab to its drag handle, Space, arrow keys, Space; the live region says where it is", async ({ page }) => {
    await open(page);
    await openDrawer(page, FERNWEH);
    const eventsBefore = await timelineLines(page).count();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-drawer")).toBeHidden();
    const handle = card(page, FERNWEH).getByTestId("card-handle");
    await handle.focus();
    await page.keyboard.press("Space");
    const live = page.locator('[id^="DndLiveRegion"]');
    await expect(live).toContainText(`${FERNWEH} 在“准备中”列上方`);
    await expect(page.getByTestId("drop-preparing")).toHaveAttribute("data-over", "true"); // the zones are measured: the arrow keys have somewhere to go
    await page.keyboard.press("ArrowRight");
    await expect(live).toContainText(`${FERNWEH} 在“已申请”列上方`);
    await page.keyboard.press("Space");
    await expect(column(page, "applied").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    // the handle has the focus again in the new column
    await expect(column(page, "applied").getByTestId("pipeline-card").filter({ hasText: FERNWEH }).getByTestId("card-handle")).toBeFocused();

    // Undo takes the move back: no extra event in the timeline, the status is back
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await page.reload();
    await openDrawer(page, FERNWEH);
    await expect(timelineLines(page)).toHaveCount(eventsBefore); // the move and its undo left no trace
  });

  test("Enter and Space on the card title and the move menu keep their own meaning (not a drag)", async ({ page }) => {
    await open(page);
    const title = card(page, FERNWEH).getByTestId("card-open");
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("card-drawer")).toBeVisible();
    // Esc closes the drawer and the focus returns to the card that opened it
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-drawer")).toBeHidden();
    await expect(card(page, FERNWEH).getByTestId("card-open")).toBeFocused();
    await card(page, FERNWEH).getByTestId("card-status").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("card-move-menu")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("columns are equal in width and the share label stays inside its column", async ({ page }) => {
    await open(page);
    const widths = await page.getByTestId("board-column").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
    expect(widths).toHaveLength(7);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const spill = await page.getByTestId("board-column").evaluateAll((nodes) =>
      nodes.map((node) => {
        const label = node.querySelector(".jr-ratio b");
        return label ? label.getBoundingClientRect().right - node.getBoundingClientRect().right : 0;
      }),
    );
    expect(spill.every((value) => value <= 0)).toBe(true);
  });

  test("a card can be dropped on an end state (the zones appear while dragging)", async ({ page }) => {
    await open(page);
    // while a card is dragged, the collapsed ended column offers its three drop zones
    await drag(page, card(page, FERNWEH), page.getByTestId("drop-withdrawn"));
    await expect(saved(page, FERNWEH, "我放弃")).toBeVisible();
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toHaveCount(0);
    await expect(page.getByTestId("ended-toggle")).toHaveAttribute("aria-expanded", "true");
    const moved = column(page, "ended").getByTestId("pipeline-card").filter({ hasText: FERNWEH });
    await expect(moved).toBeVisible();
    await expect(moved.locator("[data-slot=status-chip]")).toHaveText("我放弃");

    await moveWithMenu(moved, "preparing");
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(saved(page, FERNWEH, "准备中")).toBeVisible();
  });

  test("the drawer edits next step, interview rounds and notes, and links to the job", async ({ page }) => {
    await open(page);
    await openDrawer(page, FERNWEH);
    await expect(page.getByTestId("drawer-open-job")).toHaveAttribute("href", /\/jobs\/\d+$/);

    await page.getByTestId("next-action-input").fill("Send the tailored CV");
    await page.getByTestId("next-date-input").fill("2026-12-24");
    await page.getByTestId("next-action-save").click();
    await expect(page.getByText("下一步已保存")).toBeVisible();
    await expect(page.getByTestId("next-action-save")).toBeDisabled(); // saved: nothing left to save

    // every click is its own save; Next runs them one after another (and a reload waits for them: e2e/fixtures.ts)
    await page.getByTestId("rounds-plus").click();
    await page.getByTestId("rounds-plus").click();
    await page.getByTestId("rounds-minus").click();
    await expect(page.getByTestId("rounds-value")).toHaveText("1");

    await page.getByTestId("drawer-notes-input").fill("Recruiter is Sam, prefers email.");
    await page.getByTestId("drawer-notes-save").click();
    await expect(page.getByText("备注已保存")).toBeVisible();
    await expect(page.getByTestId("drawer-notes-save")).toBeDisabled();

    await page.keyboard.press("Escape");
    // the card shows the next step with its date and the round counter
    await expect(card(page, FERNWEH).getByTestId("card-next-date")).toBeVisible();
    await expect(card(page, FERNWEH)).toContainText("Send the tailored CV");
    await expect(card(page, FERNWEH).getByTestId("card-rounds")).toContainText("面试 1 轮");

    await page.reload();
    await openDrawer(page, FERNWEH);
    await expect(page.getByTestId("next-action-input")).toHaveValue("Send the tailored CV");
    await expect(page.getByTestId("next-date-input")).toHaveValue("2026-12-24");
    await expect(page.getByTestId("rounds-value")).toHaveText("1");
    await expect(page.getByTestId("drawer-notes-input")).toHaveValue("Recruiter is Sam, prefers email.");

    // clean up: blank next step, zero rounds, no notes
    await page.getByTestId("next-action-input").fill("");
    await page.getByTestId("next-date-input").fill("");
    await page.getByTestId("next-action-save").click();
    await expect(page.getByText("下一步已保存")).toBeVisible(); // (the reload above cleared the earlier toasts)
    await expect(page.getByTestId("next-action-save")).toBeDisabled();
    await page.getByTestId("rounds-minus").click();
    await expect(page.getByTestId("rounds-value")).toHaveText("0");
    await page.getByTestId("drawer-notes-input").fill("");
    await page.getByTestId("drawer-notes-save").click();
    await expect(page.getByText("备注已保存")).toBeVisible();
    await expect(page.getByTestId("drawer-notes-save")).toBeDisabled();
    // the stepper's last change is a server action too: it is stored once the board card shows 0 rounds
    await page.keyboard.press("Escape");
    await expect(card(page, FERNWEH).getByTestId("card-rounds")).toHaveCount(0);
  });

  test("search and the overdue-only toggle filter the board and keep their state after a reload", async ({ page }) => {
    await open(page);
    await page.getByTestId("overdue-toggle").click();
    await expect(page).toHaveURL(/overdue=true/);
    await expect(page.getByTestId("pipeline-card")).toHaveCount(2); // Quillfeather (interested) and Tidewater (applied)
    await page.reload();
    await expect(page.getByTestId("overdue-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pipeline-card")).toHaveCount(2);
    await page.getByTestId("pipeline-filter-clear").click();
    await expect(page).not.toHaveURL(/overdue=/);

    await page.getByTestId("pipeline-search").fill("fernweh");
    await expect(page).toHaveURL(/q=fernweh/);
    await expect(page.getByTestId("pipeline-card")).toHaveCount(1);
    await page.getByTestId("pipeline-search").fill("");
    await expect.poll(() => page.getByTestId("pipeline-card").count()).toBeGreaterThan(2);
  });

  test("English renders the board", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "切换语言" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();
    await expect(column(page, "interested").locator("h2, span").first()).toContainText("Interested");
    await expect(card(page, "Quillfeather Labs").getByTestId("card-overdue")).toContainText("Interested for 9 days, not applied");
    // back to Chinese for the next tests
    await page.getByRole("button", { name: "Switch language" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  });

  test("the terminal theme renders the board and the drawer", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "切换深浅主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(card(page, "Quillfeather Labs").getByTestId("card-overdue")).toBeVisible();
    await openDrawer(page, "Quillfeather Labs");
    await expect(page.getByTestId("drawer-overdue")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "切换深浅主题" }).click(); // back to paper for the next tests
    await expect(page.locator("html")).toHaveClass(/light/);
  });
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the page fits, the status menu moves a card, and the drawer opens", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await card(page, FERNWEH).scrollIntoViewIfNeeded();
    await moveWithMenu(card(page, FERNWEH), "applied");
    await expect(column(page, "applied").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(saved(page, FERNWEH, "已申请")).toBeVisible();
    await moveWithMenu(card(page, FERNWEH), "preparing");
    await expect(column(page, "preparing").getByTestId("pipeline-card").filter({ hasText: FERNWEH })).toBeVisible();
    await expect(saved(page, FERNWEH, "准备中")).toBeVisible();

    await openDrawer(page, FERNWEH);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.getByTestId("timeline")).toBeVisible();
    // the log lines say what happened even while the log is below the fold of the scrolling drawer (no empty, timestamp-only lines)
    const widths = await timelineLines(page).locator(".jr-term__txt").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.every((width) => width > 0)).toBe(true);
  });

  test("opens on the first column that has cards", async ({ page }) => {
    await open(page);
    const board = page.getByTestId("board");
    const firstWithCards = page.locator('[data-testid="board-column"]').filter({ has: page.getByTestId("pipeline-card") }).first();
    const [boardBox, columnBox] = await Promise.all([board.boundingBox(), firstWithCards.boundingBox()]);
    expect(columnBox && boardBox && columnBox.x >= boardBox.x - 1 && columnBox.x < boardBox.x + boardBox.width).toBe(true);
  });
});
