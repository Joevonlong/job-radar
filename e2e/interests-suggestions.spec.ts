import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * The suggestions block of /interests against the disposable database and the private copies of
 * config/ and data/profile (see playwright.config.ts). The suggestions are inserted here; what the AI does is
 * covered by tests/integration/interest-suggestions.test.ts. The UI is Chinese by default.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const PROFILE_DIR = process.env.E2E_PROFILE_DIR ?? "";
const INTERESTS_FILE = path.join(CONFIG_DIR, "interests.yaml");
const PREFS_FILE = path.join(PROFILE_DIR, "preferences.yaml");
const read = (file: string) => fs.readFileSync(file, "utf8");

// One config directory, one profile directory and one database: run the tests one after another.
test.describe.configure({ mode: "serial" });

const common = (reasonZh: string) => ({
  reasonZh,
  reasonEn: "reason",
  confidence: 0.82,
  evidence: [
    { jobId: 1, title: "AI Engineer", company: "Northwind", quote: "We offer a gym membership." },
    { jobId: 2, title: "ML Engineer", company: "Acme", quote: "A gym membership for everyone." },
  ],
});

const SUGGESTIONS = [
  { kind: "signal_word", key: "signal_word:gym membership", payload: { kind: "signal_word", tier: "benefit_tag", term: "gym membership", ...common("两个岗位都提到健身房补贴") } },
  { kind: "watched_company", key: "watched_company:northwind", payload: { kind: "watched_company", company: "Northwind", ...common("你申请了它两个岗位") } },
  { kind: "filter", key: "filter:exclude_keyword:cobol", payload: { kind: "filter", action: "exclude_keyword", value: "Cobol", ...common("被忽略的岗位都有") } },
];

async function resetSuggestions() {
  const sql = postgres(process.env.E2E_DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
  try {
    await sql`truncate table interest_suggestions restart identity`;
    for (const s of SUGGESTIONS) await sql`insert into interest_suggestions (kind, dedupe_key, payload_json) values (${s.kind}, ${s.key}, ${sql.json(s.payload)})`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.beforeEach(async () => {
  fs.copyFileSync(path.join(process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults"), "interests.yaml"), INTERESTS_FILE);
  fs.rmSync(PREFS_FILE, { force: true });
  await resetSuggestions();
});

const byKind = (page: Page, kind: string) => page.locator(`[data-testid="suggestion-item"][data-kind="${kind}"]`);

async function open(page: Page) {
  await page.goto("/interests");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "感兴趣清单" })).toBeVisible();
}

test("approve writes the lists, reject leaves them, the decided ones move to the history", async ({ page }) => {
  await open(page);
  const card = page.getByTestId("suggestions-card");
  await expect(card.getByRole("heading", { name: "学习建议" })).toBeVisible();
  await expect(page.getByTestId("suggestions-count")).toHaveText("3");
  await expect(page.getByTestId("suggestion-item")).toHaveCount(3);

  // the evidence is one click away, with the verbatim quote and a link to the job
  const word = byKind(page, "signal_word");
  await expect(word).toContainText("两个岗位都提到健身房补贴");
  await expect(word).toContainText("把握 82%");
  await word.getByText("2 个岗位的证据").click();
  await expect(word.getByText("“We offer a gym membership.”")).toBeVisible();
  await expect(word.getByRole("link", { name: "AI Engineer · Northwind" })).toHaveAttribute("href", "/jobs/1");

  // approve the word: it is written into interests.yaml with the comments around it kept
  expect(read(INTERESTS_FILE)).not.toContain("gym membership");
  await word.getByTestId("suggestion-approve").click();
  await expect(page.getByTestId("suggestion-approved")).toContainText("已加入你的清单");
  await expect(page.getByTestId("suggestion-item")).toHaveCount(2);
  await expect.poll(() => read(INTERESTS_FILE)).toContain("gym membership");
  expect(read(INTERESTS_FILE)).toContain("# 福利标签：只显示，不加分");

  // reject the company: nothing is written
  const company = byKind(page, "watched_company");
  await company.getByTestId("suggestion-reject").click();
  await expect(page.getByTestId("suggestion-item")).toHaveCount(1);
  expect(read(INTERESTS_FILE)).toMatch(/watched_companies: \[\]/);

  // approve the filter: preferences.yaml gets the keyword
  await page.getByTestId("suggestion-item").getByTestId("suggestion-approve").click();
  await expect(page.getByTestId("suggestions-empty")).toBeVisible();
  await expect.poll(() => (fs.existsSync(PREFS_FILE) ? read(PREFS_FILE) : "")).toContain("Cobol");

  // after a reload the three decided suggestions are in the history, none is pending
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("suggestions-empty")).toBeVisible();
  const history = page.getByTestId("suggestion-history");
  await history.getByText("最近处理过的（3）").click();
  await expect(history.getByRole("listitem")).toHaveCount(3);
  await expect(history.locator('[data-status="rejected"]')).toContainText("关注公司");
});

test("'look for suggestions now' queues a request and the page shows how the last run went", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("suggest-last-run")).toHaveCount(0);
  await page.getByTestId("suggest-run").click();
  await expect(page.getByTestId("suggest-run-queued")).toContainText("已请求");

  // the stand-in runner answers within a poll or two
  await expect
    .poll(async () => {
      await page.reload();
      await page.waitForLoadState("networkidle");
      return page.getByTestId("suggest-last-run").textContent();
    }, { timeout: 20_000 })
    .toContain("感兴趣的岗位太少");
});

test("the page works on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  await expect(page.getByTestId("suggestion-item")).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
