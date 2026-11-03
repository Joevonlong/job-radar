import postgres from "postgres";

import { expect, test, type Page } from "./fixtures";

// One application's status and the one seeded reply: this spec has its own project in SERIAL_CHAIN.
test.describe.configure({ mode: "serial" });

const COMPANY = "Tidewater Robotics";
const REPLY_KEY = "seed:reply:interview";

function database() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !new URL(url).pathname.slice(1).startsWith("jobradar_e2e")) throw new Error("A disposable E2E_DATABASE_URL is required");
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function resetReply(): Promise<void> {
  const sql = database();
  try {
    await sql`update email_replies set state = 'pending', decided_at = null, event_id = null where dedupe_key = ${REPLY_KEY}`;
    await sql`update applications set status = 'applied' where id = (select application_id from email_replies where dedupe_key = ${REPLY_KEY})`;
  } finally {
    await sql.end();
  }
}

const card = (page: Page) => page.locator(`[data-slot="pipeline-card"][aria-label^="${COMPANY}"]`).first();

test.beforeEach(resetReply);
test.afterAll(resetReply);

async function confirmThenUndo(page: Page): Promise<void> {
  await page.goto("/pipeline");
  await expect(card(page)).toHaveAttribute("data-status", "applied");
  await expect(card(page).getByTestId("card-replies")).toBeVisible();

  // closed by default: the board keeps its height
  await expect(page.getByTestId("replies-body")).toHaveCount(0);
  await page.getByTestId("replies-toggle").click();
  const row = page.getByTestId("reply-row").first();
  await expect(row).toHaveAttribute("data-category", "interview_invite");
  await expect(row.getByTestId("reply-application")).toContainText(COMPANY);

  await row.getByTestId("reply-confirm").click();
  await expect(card(page)).toHaveAttribute("data-status", "interviewing");
  await expect(card(page).getByTestId("card-replies")).toHaveCount(0);

  // survives a reload, with the undo still there
  await page.reload();
  await expect(card(page)).toHaveAttribute("data-status", "interviewing");
  await page.getByTestId("replies-toggle").click();
  await page.getByTestId("replies-recent").getByTestId("reply-undo").click();
  await expect(card(page)).toHaveAttribute("data-status", "applied");
  await page.reload();
  await expect(card(page)).toHaveAttribute("data-status", "applied");
}

test("a reply changes nothing until it is confirmed, and the undo takes it back", async ({ page }) => {
  await confirmThenUndo(page);
});

test("the same on a phone, in dark mode", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.goto("/pipeline");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByTestId("replies-toggle").click();
  const row = page.getByTestId("reply-row").first();
  await expect(row.getByTestId("reply-confirm")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("dismissing leaves the application alone", async ({ page }) => {
  await page.goto("/pipeline");
  await page.getByTestId("replies-toggle").click();
  await page.getByTestId("reply-row").first().getByTestId("reply-dismiss").click();
  await expect(card(page).getByTestId("card-replies")).toHaveCount(0);
  await expect(card(page)).toHaveAttribute("data-status", "applied");
});
