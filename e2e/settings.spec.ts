import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { parse } from "yaml";

import { expect, test, type Page } from "./fixtures";

/**
 * Settings page against the disposable database and a private copy of config/ (see
 * playwright.config.ts). e2e/global-setup.ts starts scripts/e2e-runner.ts: a stand-in runner that
 * sends heartbeats, acknowledges config files it has loaded and answers control requests (its
 * "run a cycle" is a stub that takes about 1.5 s). The UI is Chinese by default.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
// The defaults the run uses (the test fixture snapshot, see playwright.config.ts); CONFIG_DIR is the user directory
const SHIPPED_CONFIG_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
/** `channels` is the config name of config/sources.yaml. */
const fileName = (name: string) => (name === "channels" ? "sources.yaml" : `${name}.yaml`);
const file = (name: string) => path.join(CONFIG_DIR, fileName(name));
const read = (name: string) => fs.readFileSync(file(name), "utf8");

// The tests share one config directory and one database: run them one after another.
test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  // Every test starts from the shipped files: the user files copied, models.yaml (a shipped file) read from the defaults.
  for (const name of ["schedule", "search", "channels", "ai", "notify", "ui"]) fs.copyFileSync(path.join(SHIPPED_CONFIG_DIR, fileName(name)), file(name));
  fs.rmSync(file("models"), { force: true });
});

// A test may leave a models.yaml override edited or broken; the other specs (sources) read the same directory, so drop it at once
test.afterEach(() => {
  fs.rmSync(file("models"), { force: true });
});

/** The models.yaml in use: the user's override when a test wrote one, else the shipped default. */
const readModels = () => (fs.existsSync(file("models")) ? read("models") : fs.readFileSync(path.join(SHIPPED_CONFIG_DIR, "models.yaml"), "utf8"));

async function open(page: Page, tab: string) {
  await page.goto(`/settings?tab=${tab}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  // the stand-in runner is up (its line is the manual operations panel's, which has its own tab)
  if (tab === "actions") await expect(page.getByTestId("runner-line")).toHaveAttribute("data-state", "online");
}

const save = (page: Page, tab: string) => page.getByTestId(`settings-card-${tab}`).getByRole("button", { name: "保存", exact: true }).click();

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`the save bar floats at the bottom of the ${viewport.width}px viewport while edits are unsaved, and leaving asks first`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "schedule");
    const card = page.getByTestId("settings-card-schedule");
    const bar = card.getByTestId("save-bar");
    await expect(bar.getByRole("button", { name: "保存", exact: true })).toBeDisabled();

    await card.getByRole("textbox", { name: "Cron 表达式" }).nth(2).fill("0 10 * * 0,6");
    await expect(bar).toHaveAttribute("data-dirty", "true");
    await expect(bar.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
    // scrolled to the top, to the middle and to the end: the bar is always inside the viewport
    for (const y of [0, 600, 1500]) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await expect(bar).toBeInViewport({ ratio: 1 });
    }

    // an in-app link asks first; "留下" keeps the page and the edit
    if (viewport.width < 768) await page.getByRole("button", { name: "打开导航菜单" }).click();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: /我的画像/ }).click();
    const dialog = page.getByTestId("unsaved-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "留下" }).click();
    await expect(page).toHaveURL(/\/settings/);
    // the phone's drawer stayed open behind the dialog
    if (viewport.width < 768) {
      await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }
    await expect(card.getByRole("textbox", { name: "Cron 表达式" }).nth(2)).toHaveValue("0 10 * * 0,6");
  });
}

test("cron boxes carry a reading of what they mean; the interface tab says the web app reads its file", async ({ page }) => {
  await open(page, "schedule");
  const card = page.getByTestId("settings-card-schedule");
  await expect(card.getByTestId("cron-chip").first()).toHaveText("工作日 07:00");
  await page.getByTestId("tab-ui").click();
  await expect(page.getByTestId("ack-ui")).toHaveAttribute("data-state", "web");
});

test("the remote scope option names what it keeps, a hint explains it and the field says what it decides", async ({ page }) => {
  await open(page, "search");
  const card = page.getByTestId("settings-card-search");
  const scope = card.getByTestId("remote-scope-kind");
  await expect(scope.locator("option[value=home_country]")).toHaveText("能从德国远程（含面向欧盟 / 欧洲 / EMEA / 全球的远程岗）");
  await expect(card.getByTestId("remote-scope-hint")).toBeVisible();
  await expect(card).toContainText("过滤用的是“我的画像”里的同名设置");
  await scope.selectOption("worldwide");
  await expect(card.getByTestId("remote-scope-hint")).toContainText("所有远程岗都保留");
});

test("change a search keyword and save: the YAML keeps its comments and the runner confirms the reload", async ({ page }) => {
  await open(page, "search");
  const card = page.getByTestId("settings-card-search");
  const before = read("search");
  expect(before).toContain("# 工程类");
  expect(before).not.toContain("Agent Developer");

  const group = card.getByTestId("keyword-group").first();
  await expect(group.getByLabel("组 ID")).toHaveValue("engineering");
  await group.getByPlaceholder("输入后按 Enter 添加").fill("Agent Developer");
  await group.getByPlaceholder("输入后按 Enter 添加").press("Enter");
  await card.getByLabel("早轮回看时间窗（小时）").fill("30");
  await card.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect.poll(() => read("search")).toContain("Agent Developer");
  const after = read("search");
  expect(after).toContain("morning: 30");
  expect(after).toContain("# 工程类");
  expect(after).toContain("# 搜索条件");

  // the stand-in runner reloads the file (its log says "config search reloaded") and reports it
  await expect(page.getByTestId("ack-search")).toHaveAttribute("data-state", "loaded", { timeout: 15_000 });
  await expect(page.getByTestId("ack-search")).toContainText(/runner 已加载（\d{2}:\d{2}）/);

  // values survive a reload
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("settings-card-search").getByLabel("早轮回看时间窗（小时）")).toHaveValue("30");
  await expect(page.getByTestId("settings-card-search").getByText("Agent Developer", { exact: true })).toBeVisible();
});

test("schedule tab: the 24 h timeline follows the form, changed fields turn yellow, the save bar counts and the runner confirms", async ({ page }) => {
  await open(page, "schedule");
  const card = page.getByTestId("settings-card-schedule");
  const timeline = card.getByTestId("schedule-timeline");
  await expect(timeline.getByTestId("timeline-zone")).toHaveText("Europe/Berlin");
  await expect(timeline.getByTestId("timeline-run")).toHaveCount(3);
  await expect(timeline.getByTestId("timeline-run").first()).toHaveAttribute("data-minutes", "420");
  // quiet hours of notify.yaml (22:00-07:00) are hatched in two pieces
  await expect(timeline.getByTestId("timeline-quiet")).toHaveCount(2);
  await expect(timeline.getByTestId("timeline-now")).toBeVisible();

  const bar = card.getByTestId("save-bar");
  await expect(bar).toHaveAttribute("data-dirty", "false");
  const cron = card.getByRole("textbox", { name: "Cron 表达式" }).nth(2);
  await cron.fill("0 10 * * 0,6");
  await expect(bar).toHaveAttribute("data-dirty", "true");
  await expect(bar).toContainText("1 处未保存");
  await expect(cron).toHaveCSS("background-color", /rgb\(242, 194, 0\)/);
  await expect(timeline.getByTestId("timeline-run").nth(1)).toHaveAttribute("data-minutes", "600");

  await bar.getByRole("button", { name: "还原", exact: true }).click();
  await expect(bar).toHaveAttribute("data-dirty", "false");
  await expect(cron).toHaveValue("0 9 * * 0,6");

  await cron.fill("0 10 * * 0,6");
  await save(page, "schedule");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect.poll(() => read("schedule")).toMatch(/cron: "0 10 \* \* 0,6"/);
  await expect(bar).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("ack-schedule")).toHaveAttribute("data-state", "loaded", { timeout: 15_000 });
});

test("界面 tab: change the salary axis, save, the runner confirms and a bad axis is refused", async ({ page }) => {
  await open(page, "ui");
  const card = page.getByTestId("settings-card-ui");
  await expect(card.getByLabel("薪资轴最大值（千，基准货币）")).toHaveValue("200");
  expect(read("ui")).toContain("# 界面（docs/settings.md）");

  await card.getByLabel("薪资轴最大值（千，基准货币）").fill("240");
  await card.getByLabel("趋势线取几轮").fill("10");
  await save(page, "ui");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect.poll(() => read("ui")).toContain("max_k: 240");
  expect(read("ui")).toContain("trend_cycles: 10");
  expect(read("ui")).toContain("# 薪资轴");
  // ui.yaml is read by the web app itself: no runner acknowledgement, the save bar says so
  await expect(page.getByTestId("ack-ui")).toHaveAttribute("data-state", "web");

  const before = read("ui");
  await card.getByLabel("薪资轴最大值（千，基准货币）").fill("30");
  await save(page, "ui");
  await expect(card.getByRole("alert").filter({ hasText: "最大值必须大于最小值" })).toBeVisible();
  expect(read("ui")).toBe(before);
});

test("invalid values show field errors and leave the file unchanged", async ({ page }) => {
  await open(page, "search");
  const card = page.getByTestId("settings-card-search");
  const before = read("search");

  const evening = card.getByLabel("晚轮回看时间窗（小时）");
  await evening.fill("abc");
  await card.getByLabel("每组每城市最多条数").fill("0");
  await save(page, "search");
  await expect(card.getByRole("alert").filter({ hasText: "请输入数字" })).toBeVisible();
  await expect(card.getByRole("alert").filter({ hasText: "必须大于 0" })).toBeVisible();
  await expect(evening).toHaveAttribute("aria-invalid", "true");
  expect(read("search")).toBe(before);
  await expect(page.getByText("已保存", { exact: true })).toHaveCount(0);

  // fixing the values and saving again works
  await evening.fill("12");
  await card.getByLabel("每组每城市最多条数").fill("20");
  await save(page, "search");
  await expect.poll(() => read("search")).toContain("evening: 12");
  await expect(card.getByRole("alert")).toHaveCount(0);

  // a bad cron expression is reported on its own field
  await page.getByTestId("tab-schedule").click();
  const schedule = page.getByTestId("settings-card-schedule");
  const scheduleBefore = read("schedule");
  await schedule.getByLabel("Cron 表达式").first().fill("0 7 * *");
  await save(page, "schedule");
  await expect(schedule.getByRole("alert")).toContainText("Cron 表达式不合法");
  expect(read("schedule")).toBe(scheduleBefore);
});

test("reorder the LinkedIn cascade and switch a channel off; channels are collapsible sections", async ({ page }) => {
  await open(page, "channels");
  const card = page.getByTestId("settings-card-channels");
  const before = read("channels");

  const brightdata = card.getByTestId("section-linkedin-brightdata");
  await expect(brightdata).not.toHaveAttribute("open", "");
  await brightdata.locator("summary").click();
  await expect(brightdata).toHaveAttribute("open", "");
  await expect(brightdata.getByLabel("数据集 ID")).toHaveValue("gd_lpfll7v5hcqtkxl6l");

  const list = card.getByRole("list").filter({ has: page.getByRole("button", { name: "上移 linkedin-guest" }) });
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await expect(list.getByRole("listitem").nth(2)).toHaveAttribute("data-value", "linkedin-monid");
  await card.getByRole("button", { name: "上移 linkedin-guest" }).click();
  await card.getByRole("button", { name: "上移 linkedin-guest" }).click();
  await card.getByRole("button", { name: "上移 linkedin-guest" }).click();
  await expect(list.getByRole("listitem").nth(1)).toHaveAttribute("data-value", "linkedin-guest");

  const indeed = card.getByTestId("section-indeed");
  await indeed.locator("summary").click();
  const indeedSwitch = indeed.getByRole("switch", { name: "启用" });
  await expect(indeedSwitch).toBeChecked();
  await indeedSwitch.click();
  await save(page, "channels");

  await expect.poll(() => read("channels")).toMatch(/cascade:\n\s+- linkedin-brightdata\n\s+- linkedin-guest\n\s+- linkedin-apify\n\s+- linkedin-monid\n\s+- linkedin-session\n/);
  const after = read("channels");
  expect(after).not.toBe(before);
  expect(after).toContain("# 采集通道");
  expect(after).toContain("# 级联：主搜索每轮只用排在最前且");
  expect(after).toMatch(/indeed:\n\s+enabled: false/);
  await expect(page.getByTestId("ack-channels")).toHaveAttribute("data-state", "loaded", { timeout: 15_000 });
});

test("run a cycle now: the request shows up, runs and completes", async ({ page }) => {
  // may wait for the other run_cycle test's turn first
  test.slow();
  // Advisory lock 120: sources.spec's backfill test queues run_cycle requests too (an open one would be joined or would refuse
  // the other), so the two tests take turns. Released when the lock's connection ends.
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is required");
  const lock = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await lock`select pg_advisory_lock(120)`;
    await runCycleNow(page);
  } finally {
    await lock.end({ timeout: 5 });
  }
});

async function runCycleNow(page: Page): Promise<void> {
  await open(page, "actions");
  const button = page.getByRole("button", { name: "立即跑一轮" });
  await expect(button).toBeEnabled();
  await button.click();

  const requests = page.getByTestId("control-requests");
  const request = requests.getByTestId("control-request").first();
  await expect(request).toHaveAttribute("data-kind", "run_cycle");
  await expect(request).toHaveAttribute("data-status", /pending|running/);
  await expect(button).toBeDisabled();

  // the page keeps asking the server while the request is open (every 2 s)
  await expect(request).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(request).toContainText("已完成");
  await expect(button).toBeEnabled();

  // a second one can be requested after the first finished
  await button.click();
  await expect(requests.getByTestId("control-request")).toHaveCount(2);
  await expect(requests.getByTestId("control-request").first()).toHaveAttribute("data-status", "done", { timeout: 20_000 });
}

test("re-score stale scores: the button shows the count and the request completes (the stand-in runner cannot re-score)", async ({ page }) => {
  await open(page, "actions");
  // the seeded database has stale scores; the count comes from the database
  const button = page.getByRole("button", { name: /重打 \d+ 条过期分数/ });
  await expect(button).toBeEnabled();
  await button.click();

  const request = page.getByTestId("control-requests").getByTestId("control-request").first();
  await expect(request).toHaveAttribute("data-kind", "rescore_stale");
  await expect(request).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  // the stand-in runner only has the default handler: it says so instead of claiming a re-score
  await expect(request).toContainText("没有重新打分的能力");
});

test("AI tab: models come from the catalog under each provider", async ({ page }) => {
  await open(page, "ai");
  const card = page.getByTestId("settings-card-ai");
  // the read-only disclosure lists, per task, the providers from the saved ai.yaml and links the doc
  await expect(card.getByTestId("disclosure-row-score").locator("[data-provider]").first()).toBeVisible();
  await expect(card.getByTestId("section-disclosure").getByTestId("doc-link-aiProviders")).toHaveAttribute("href", /ai-providers\.zh\.md#/);
  const claude = card.getByTestId("section-claude_cli");
  // the row already says which model it uses
  await expect(card.getByTestId("vendor-anthropic").getByTestId("vendor-active")).toContainText("Claude Haiku 4.5");
  const model = claude.getByRole("combobox", { name: "模型", exact: true });
  await expect(model).toHaveValue("claude-haiku-4-5");
  await expect(model.locator("option")).toHaveText(["Claude Haiku 4.5 · claude-haiku-4-5", "Claude Sonnet 5.5 · claude-sonnet-5-5", "Claude Opus 5.5 · claude-opus-5-5"]);
  // no tag box for the model list, no price table
  await expect(card.getByRole("textbox", { name: "可选模型" })).toHaveCount(0);
  await expect(card.getByText("模型单价")).toHaveCount(0);
  await card.getByTestId("catalog-anthropic").locator("summary").click();
  await expect(card.getByTestId("model-catalog-claude-cli").getByTestId("catalog-row")).toHaveCount(3);
  // on a phone the equivalent price of a subscription model wraps instead of being cut off
  await page.setViewportSize({ width: 390, height: 844 });
  for (const cell of await card.getByTestId("model-catalog-claude-cli").locator('td[data-label^="单价"]').all()) {
    expect(await cell.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const deepseek = card.getByTestId("section-deepseek");
  await expect(deepseek.getByRole("combobox", { name: "模型", exact: true }).locator("option").first()).toContainText("$");

  const codex = card.getByTestId("section-codex_cli");
  await expect(codex.getByRole("combobox", { name: "模型", exact: true })).toHaveValue("");
  await codex.getByTestId("more-codex_cli").locator("summary").click();
  await codex.getByRole("combobox", { name: "推理强度：翻译" }).selectOption("medium");

  await model.selectOption("claude-opus-5-5");
  await save(page, "ai");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect.poll(() => read("ai")).toContain("claude-opus-5-5");
  const after = read("ai");
  const saved = parse(after) as { providers: { claude_cli: { model: string }; codex_cli: { model?: string; reasoning_effort_by_task: Record<string, string> } } };
  expect(saved.providers.claude_cli.model).toBe("claude-opus-5-5");
  expect(saved.providers.codex_cli.reasoning_effort_by_task).toEqual({ translate: "medium" });
  expect(saved.providers.codex_cli.model).toBeUndefined();
  expect(after).toContain("# 模型目录");

  // a model added to models.yaml shows up under its own provider after a reload, and only there
  const catalog = parse(readModels()) as { providers: Record<string, { models: unknown[] }> };
  catalog.providers.deepseek?.models.push({ id: "deepseek-e2e", label: "DeepSeek E2E", price: { input_per_mtok: 0.1, output_per_mtok: 0.2 } });
  fs.writeFileSync(file("models"), (await import("yaml")).stringify(catalog));
  await open(page, "ai");
  const reloaded = page.getByTestId("settings-card-ai");
  await expect(reloaded.getByTestId("section-deepseek").getByRole("combobox", { name: "模型", exact: true }).locator("option")).toContainText(["DeepSeek E2E · deepseek-e2e · $0.1 / $0.2"], { useInnerText: true });
  await expect(reloaded.getByTestId("section-claude_cli").getByRole("combobox", { name: "模型", exact: true }).locator("option")).toHaveCount(3);
});

test("task override: pick a provider, then its model", async ({ page }) => {
  await open(page, "ai");
  const card = page.getByTestId("settings-card-ai");
  // read mode is a compact line: chips, no add dropdown; Edit opens the editor in place, one at a time
  await expect(card.getByTestId("task-row-translate").getByTestId("chain")).toBeVisible();
  await expect(card.getByRole("combobox", { name: "添加" })).toHaveCount(0);
  await card.getByTestId("task-row-translate-edit").click();
  await card.getByTestId("task-row-score-edit").click();
  await expect(card.getByTestId("task-row-translate-editor")).toHaveCount(0);
  await card.getByTestId("task-row-translate-edit").click();
  const translate = card.getByTestId(/-tasks\.translate-list$/);
  await expect(translate.getByTestId("route-row")).toHaveCount(3);
  const claudeRow = translate.locator('[data-testid="route-row"][data-value="claude-cli"]');
  const choice = claudeRow.getByRole("combobox", { name: "Anthropic · 订阅 的模型" });
  await expect(choice.locator("option").first()).toHaveText("默认 · claude-haiku-4-5");
  await choice.selectOption("claude-sonnet-5-5");
  // the api layer has no model dropdown
  await expect(translate.locator('[data-testid="route-row"][data-value="api"]').getByRole("combobox")).toHaveCount(0);

  await save(page, "ai");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect.poll(() => read("ai")).toContain("claude-cli: claude-sonnet-5-5");
  const saved = parse(read("ai")) as { tasks: { translate: { order: string[]; models?: Record<string, string> }; score: { models?: unknown } } };
  expect(saved.tasks.translate.models).toEqual({ "claude-cli": "claude-sonnet-5-5" });
  expect(saved.tasks.translate.order).toContain("claude-cli");
  expect(saved.tasks.score.models).toBeUndefined();

  // after a reload the choice is still there
  await open(page, "ai");
  await expect(page.getByTestId("task-row-translate").getByTestId("chain")).toContainText("Sonnet");
  await page.getByTestId("task-row-translate-edit").click();
  await expect(page.getByTestId("settings-card-ai").getByTestId(/-tasks\.translate-list$/).locator('[data-testid="route-row"][data-value="claude-cli"]').getByRole("combobox")).toHaveValue("claude-sonnet-5-5");
});

test("a model that is not in the catalog is refused on its field and the file stays", async ({ page }) => {
  const text = read("ai").replace("model: deepseek-v4-flash", "model: deepseek-gone");
  fs.writeFileSync(file("ai"), text);
  await open(page, "ai");
  const card = page.getByTestId("settings-card-ai");
  const deepseek = card.getByTestId("section-deepseek");
  await expect(deepseek.getByText("不在目录")).toBeVisible();
  await expect(deepseek.getByRole("combobox", { name: "模型", exact: true })).toHaveValue("deepseek-gone");
  // change something unrelated: the save is still refused because of the model
  await card.getByTestId("section-mimo").getByRole("textbox", { name: "每日请求上限" }).fill("7");
  await save(page, "ai");
  await expect(deepseek.getByText("不在这个服务商的模型目录里")).toBeVisible();
  expect(read("ai")).toBe(text);
});

test("a broken models.yaml: red box in the AI tab, saving refused, the file stays", async ({ page }) => {
  // an API model without a price
  const broken = fs.readFileSync(path.join(SHIPPED_CONFIG_DIR, "models.yaml"), "utf8").replace(/\n\s+price: \{ input_per_mtok: 1, output_per_mtok: 5 \}/, "");
  fs.writeFileSync(file("models"), broken);
  const aiBefore = read("ai");
  await open(page, "ai");
  const card = page.getByTestId("settings-card-ai");
  await expect(card.getByTestId("catalog-error")).toContainText("models.yaml 读不了");
  await expect(card.getByTestId("catalog-error")).toContainText("price");
  // other tabs are unaffected
  await expect(page.getByTestId("settings-card-search")).toBeAttached();
  const mimo = card.getByTestId("section-mimo");
  await mimo.getByRole("textbox", { name: "每日请求上限" }).fill("9");
  await save(page, "ai");
  await expect(card.getByText("模型目录读不了，先修好 models.yaml")).toBeVisible();
  expect(read("ai")).toBe(aiBefore);
});

test("send a Telegram test message: asks first, then shows what the runner reports", async ({ page }) => {
  await open(page, "actions");
  const trigger = page.getByTestId("trigger-testTelegram");
  await trigger.getByRole("button", { name: "发送 Telegram 测试消息" }).click();
  await expect(trigger.getByText("确定发一条测试消息到 Telegram？")).toBeVisible();
  await trigger.getByTestId("trigger-testTelegram-confirm").click();
  await expect(trigger.getByTestId("trigger-outcome")).toContainText("已发送（消息 #4242）", { timeout: 15_000 });
});

test("the manual operations panel is a tab of its own, not under the other tabs", async ({ page }) => {
  await open(page, "actions");
  await expect(page.getByTestId("control-card")).toBeVisible();
  await expect(page.getByTestId("tab-actions")).toHaveAttribute("data-state", "active");
  for (const tab of ["schedule", "search", "channels", "ai", "breakdown", "notify", "ui"]) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId("control-card")).toHaveCount(0);
    await expect(page.getByTestId(`settings-card-${tab}`)).toBeVisible();
  }
  await page.getByTestId("tab-actions").click();
  await expect(page).toHaveURL(/tab=actions/);
  await expect(page.getByTestId("control-card")).toBeVisible();
});

test("AI tab: four numbered blocks; the Anthropic card has a subscription row and an API row, each with its own switch and models", async ({ page }) => {
  await open(page, "ai");
  const card = page.getByTestId("settings-card-ai");
  for (const id of ["providers", "routing", "limits", "scoring"]) await expect(card.getByTestId(`ai-block-${id}`)).toBeVisible();
  await expect(card.getByTestId("vendor-anthropic").getByTestId("section-claude_cli")).toBeVisible();
  const api = card.getByTestId("vendor-anthropic").getByTestId("section-anthropic");
  await expect(api).toHaveAttribute("data-enabled", "1");
  // the API row switches models on its own and saves; the subscription row is untouched
  const before = parse(read("ai")) as { providers: { claude_cli: { enabled: boolean; strong_model: string } } };
  // (the catalog is whatever models.yaml holds: take its last model)
  const strong = api.getByRole("combobox", { name: "强模型", exact: true });
  const picked = (await strong.locator("option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).at(-1) ?? "";
  await strong.selectOption(picked);
  await api.getByRole("switch", { name: /启用 Anthropic API/ }).click();
  await expect(api).toHaveAttribute("data-enabled", "0");
  await save(page, "ai");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect.poll(() => (parse(read("ai")) as { providers: { anthropic: { enabled: boolean } } }).providers.anthropic.enabled).toBe(false);
  const saved = parse(read("ai")) as { providers: { anthropic: { enabled: boolean; strong_model: string }; claude_cli: { enabled: boolean; strong_model: string } } };
  expect(saved.providers.anthropic).toMatchObject({ enabled: false, strong_model: picked });
  expect(saved.providers.claude_cli).toMatchObject(before.providers.claude_cli);
  await open(page, "ai");
  await expect(page.getByTestId("settings-card-ai").getByTestId("section-anthropic")).toHaveAttribute("data-enabled", "0");
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("settings and sources fit the viewport in Chinese and English, dark and light", async ({ page }) => {
    await open(page, "channels");
    const scrollWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
    expect(await scrollWidth()).toBeLessThanOrEqual(390);
    await page.getByTestId("section-linkedin-brightdata").locator("summary").click();
    expect(await scrollWidth()).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "切换深浅主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await scrollWidth()).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "切换语言" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await page.getByTestId("tab-actions").click();
    await expect(page.getByTestId("control-card")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run a cycle now" })).toBeVisible();
    expect(await scrollWidth()).toBeLessThanOrEqual(390);
    await page.getByTestId("tab-ai").click();
    await expect(page.getByTestId("settings-card-ai")).toBeVisible();
    expect(await scrollWidth()).toBeLessThanOrEqual(390);
    // The catalog table of an opened provider section and the task routes stack without sideways scroll
    await page.getByTestId("catalog-openai").locator("summary").click();
    await expect(page.getByTestId("model-catalog-codex-cli")).toBeVisible();
    expect(await scrollWidth()).toBeLessThanOrEqual(390);


    await page.goto("/sources");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
    expect(await scrollWidth()).toBeLessThanOrEqual(390);
  });
});

test("AI tab: a scoring criterion with commas is added as one sentence and saved", async ({ page }) => {
  const sentence = "A small team, real users, and a direct line to the founders";
  await open(page, "ai");
  const priorities = page.getByTestId("settings-card-ai").getByLabel("最看重", { exact: true });
  // typed key by key: a comma must not end the entry
  await priorities.click();
  await priorities.pressSequentially(sentence);
  await expect(priorities).toHaveValue(sentence);
  await priorities.press("Enter");
  await expect(page.locator('[data-slot="filter-chip"]', { hasText: sentence })).toHaveCount(1);
  // the same sentence in other case is a repeat
  await priorities.fill(sentence.toLowerCase());
  await priorities.press("Enter");
  await expect(page.locator('[data-slot="filter-chip"]', { hasText: sentence })).toHaveCount(1);
  await expect(priorities.locator("..").getByTestId("tag-duplicate")).toContainText("已在列表里");
  await priorities.fill("");
  await save(page, "ai");
  await expect(page.getByText("已保存")).toBeVisible();
  const saved = parse(read("ai")) as { scoring: { criteria: { priorities: string[] } } };
  expect(saved.scoring.criteria.priorities).toEqual([sentence]);
});

for (const width of [390, 1280, 1920]) {
  test(`a long scoring priority wraps inside its chip at ${width}px instead of being cut off`, async ({ page }) => {
    const sentence = "I want to work on the product side of machine learning with real users, a small team and a direct line to the people who decide what gets built next";
    fs.writeFileSync(file("ai"), read("ai").replace("  backlog_per_run: 40\n", `  backlog_per_run: 40\n  criteria:\n    priorities:\n      - "${sentence}"\n`));
    await page.setViewportSize({ width, height: 1000 });
    await open(page, "ai");
    const chip = page.locator('[data-slot="filter-chip"]', { hasText: "product side of machine learning" }).first();
    await chip.scrollIntoViewIfNeeded();
    await expect(chip).toBeVisible();
    // the whole sentence is there and nothing is clipped
    await expect(chip).toContainText("what gets built next");
    const text = chip.locator("span").first();
    const clipped = await text.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflowX).toBe(false);
    await page.screenshot({ path: path.resolve(process.env.E2E_SHOTS_DIR ?? "test-results", `b067-priorities-${width}.png`) });
  });
}

for (const locale of ["zh", "en"] as const) {
  test(`company-query settings save and reload all controls (${locale})`, async ({ page }) => {
    await page.context().addCookies([{ name: "NEXT_LOCALE", value: locale, url: `http://127.0.0.1:${process.env.E2E_PORT ?? "3100"}` }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings?tab=search");
    const card = page.getByTestId("settings-card-search");
    const control = card.getByRole("switch", { name: locale === "en" ? "Search watched companies" : "查询关注公司", exact: true });
    await expect(control).toBeChecked();
    await control.click();
    const fields = locale === "en"
      ? ["Company queries per unit per cycle", "Minimum company query interval", "Results per company query"]
      : ["每个单元每轮的公司查询上限", "同一公司查询的最短间隔", "每条公司查询的结果上限"];
    for (const [index, label] of fields.entries()) await card.getByRole("textbox", { name: label, exact: true }).fill(String([2, 8, 13][index]));
    await card.getByRole("button", { name: locale === "en" ? "Save" : "保存", exact: true }).click();
    await expect.poll(() => parse(read("search")).watched_company_queries).toEqual({ enabled: false, max_per_cycle: 2, min_interval_hours: 8, max_results: 13 });
    await page.reload();
    await expect(control).not.toBeChecked();
    for (const [index, label] of fields.entries()) await expect(card.getByRole("textbox", { name: label, exact: true })).toHaveValue(String([2, 8, 13][index]));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    fs.mkdirSync("/tmp/company-query-shots", { recursive: true });
    await page.screenshot({ path: `/tmp/company-query-shots/settings-${locale}-390.png`, fullPage: true });
  });
}
