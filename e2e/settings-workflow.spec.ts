import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./fixtures";
import { parse } from "yaml";

/**
 * The application workflow tab. Hiding a status changes the board, the menus and the /jobs filter; the timeouts are
 * written to notify.yaml. Seed: Fernweh Software is in "preparing" (the card the hidden column must still show), Quillfeather
 * Labs is "interested" (overdue after 7 days). The specs rewrite ui.yaml and notify.yaml, so the file runs as its own project
 * after everything else.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
const file = (name: string) => path.join(CONFIG_DIR, `${name}.yaml`);
const yamlOf = (name: string) => parse(fs.readFileSync(file(name), "utf8")) as Record<string, unknown>;

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  for (const name of ["ui", "notify", "resume"]) fs.copyFileSync(path.join(DEFAULTS_DIR, `${name}.yaml`), file(name));
});
test.afterAll(() => {
  for (const name of ["ui", "notify", "resume"]) fs.copyFileSync(path.join(DEFAULTS_DIR, `${name}.yaml`), file(name));
});

async function openWorkflow(page: Page) {
  await page.goto("/settings?tab=workflow");
  await expect(page.getByTestId("status-table")).toBeVisible();
}

const saveWorkflow = async (page: Page) => {
  await page.getByTestId("workflow-save").click();
  await expect(page.getByTestId("workflow-card").getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
};

test("the status table lists the nine statuses; new and ignored cannot be hidden", async ({ page }) => {
  await openWorkflow(page);
  for (const status of ["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"]) {
    await expect(page.getByTestId(`status-row-${status}`)).toBeVisible();
  }
  await expect(page.getByTestId("status-show-new")).toBeDisabled();
  await expect(page.getByTestId("status-show-archived")).toBeDisabled();
  await expect(page.getByTestId("status-row-new")).toContainText("不能隐藏");
  await expect(page.getByTestId("status-show-preparing")).toBeEnabled();
  // only interested and applied have a timeout
  await expect(page.getByTestId("status-days-interested")).toHaveValue("7");
  await expect(page.getByTestId("status-days-applied")).toHaveValue("14");
  await expect(page.getByTestId("status-days-offer")).toHaveCount(0);
  // the seeded application of Fernweh is counted
  await expect(page.getByTestId("status-count-preparing")).not.toHaveText("0");
});

test("hiding 'preparing' and 'offer': the board folds the one with a card and drops the empty one; menus and /jobs follow; a URL still works", async ({ page }) => {
  await openWorkflow(page);
  await page.getByTestId("status-show-preparing").click();
  await page.getByTestId("status-show-offer").click();
  await expect(page.getByTestId("status-folds-preparing")).toContainText(/\d+ 张卡片/);
  await saveWorkflow(page);
  expect(yamlOf("ui").applications).toEqual({ hidden_statuses: expect.arrayContaining(["preparing", "offer"]) });

  await page.goto("/pipeline");
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.locator('[data-testid="board-column"][data-column="offer"]')).toHaveCount(0);
  const folded = page.locator('[data-testid="board-column"][data-column="preparing"]');
  await expect(folded).toHaveAttribute("data-hidden-column", "collapsed");
  await expect(page.getByTestId("pipeline-hidden-cards")).toContainText(/\d+/);
  await expect(page.getByTestId("drop-preparing")).toHaveCount(0);
  await expect(folded.getByText("Fernweh Software")).toHaveCount(0);
  await folded.getByTestId("hidden-toggle-preparing").click();
  const card = folded.getByTestId("pipeline-card").filter({ hasText: "Fernweh Software" });
  await expect(card).toBeVisible();

  // another card's menu does not list the hidden statuses; the folded card's own status stays, marked hidden
  const other = page.getByTestId("pipeline-card").filter({ hasText: "Quillfeather Labs" });
  await other.getByTestId("card-status").click();
  await expect(page.getByTestId("card-move-preparing")).toHaveCount(0);
  await expect(page.getByTestId("card-move-offer")).toHaveCount(0);
  await expect(page.getByTestId("card-move-applied")).toBeVisible();
  await page.keyboard.press("Escape");
  await card.getByTestId("card-status").click();
  await expect(page.getByTestId("card-move-preparing")).toContainText("已隐藏");
  await page.keyboard.press("Escape");

  // the /jobs filter does not offer them, a link that names one still works
  await page.goto("/jobs");
  await expect(page.getByTestId("filter-app-applied")).toBeVisible();
  await expect(page.getByTestId("filter-app-preparing")).toHaveCount(0);
  await expect(page.getByTestId("filter-app-offer")).toHaveCount(0);
  await page.goto("/jobs?app=preparing");
  await expect(page.getByTestId("filter-app-preparing")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Fernweh Software").first()).toBeVisible();

  // put it back: the column returns
  await openWorkflow(page);
  await page.getByTestId("status-show-preparing").click();
  await page.getByTestId("status-show-offer").click();
  await saveWorkflow(page);
  await page.goto("/pipeline");
  await expect(page.locator('[data-testid="board-column"][data-column="offer"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="board-column"][data-column="preparing"]')).not.toHaveAttribute("data-hidden-column", /.+/);
});

test("the 'interested' timeout 7 -> 3 goes to notify.yaml; the board header follows; the notify tab no longer has the field", async ({ page }) => {
  await openWorkflow(page);
  await page.getByTestId("status-days-interested").fill("3");
  await saveWorkflow(page);
  expect((yamlOf("notify").reminders as Record<string, unknown>).interested_days).toBe(3);

  await page.goto("/pipeline");
  await expect(page.getByTestId("pipeline-summary")).toContainText("3");
  await page.goto("/settings?tab=notify");
  await expect(page.getByTestId("settings-card-notify")).toBeVisible();
  await expect(page.getByLabel("“感兴趣”提醒（天）")).toHaveCount(0);
  await expect(page.getByTestId("reminder-link")).toBeVisible();
  // the Telegram block: names and state only, and the host command to set it up
  await expect(page.getByTestId("telegram-status")).toBeVisible();
  await expect(page.getByTestId("telegram-status").getByTestId("env-presence")).toContainText("TELEGRAM_BOT_TOKEN");
  await expect(page.getByTestId("telegram-setup-command").first()).toHaveText("pnpm run setup --step telegram");
});

test("hiding the workplace 'onsite' and the contract 'temp agency' removes them from the /jobs filter", async ({ page }) => {
  await openWorkflow(page);
  await page.getByTestId("workplace-show-onsite").click();
  await page.getByTestId("contract-show-temp_agency").click();
  await saveWorkflow(page);
  const ui = yamlOf("ui") as { filters: { hidden_workplaces: string[]; hidden_contracts: string[] } };
  expect(ui.filters.hidden_workplaces).toEqual(["onsite"]);
  expect(ui.filters.hidden_contracts).toEqual(["temp_agency"]);

  await page.goto("/jobs");
  await page.getByTestId("filter-toggle").isVisible();
  const workplace = page.getByTestId("filter-workplace");
  await workplace.click();
  await expect(page.getByRole("option", { name: "现场" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "远程" }).first()).toBeVisible();
});

test("an invalid timeout names its field and nothing is written", async ({ page }) => {
  const before = fs.readFileSync(file("notify"), "utf8");
  await openWorkflow(page);
  await page.getByTestId("status-days-applied").fill("0");
  await page.getByTestId("workflow-save").click();
  await expect(page.getByRole("alert").filter({ hasText: "必须大于" }).first()).toBeVisible();
  expect(fs.readFileSync(file("notify"), "utf8")).toBe(before);
});

test("the resume tool form and the 390px layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkflow(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  const card = page.getByTestId("settings-card-resume");
  // the command is pasted into a shell: a protected key, shown read-only and edited only in the file
  const command = card.getByLabel("启动 Claude Code 的命令");
  await expect(command).toHaveAttribute("readonly", "");
  await expect(command).toHaveAttribute("data-locked", "true");
  await card.getByLabel("“挂上简历”下拉最多列几个 PDF").fill("7");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
  expect(yamlOf("resume").pdf_list_limit).toBe(7);
  expect(yamlOf("resume").claude_command).toBe("claude");
});
