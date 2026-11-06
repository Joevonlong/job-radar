import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "./fixtures";

test.describe.configure({ mode: "serial" });

async function withCareer(enabled: boolean, run: () => Promise<void>): Promise<void> {
  const dir = process.env.E2E_CONFIG_DIR;
  const profile = process.env.E2E_PROFILE_DIR;
  if (!dir || !profile) throw new Error("E2E_CONFIG_DIR and E2E_PROFILE_DIR are required");
  const file = path.join(dir, "career.yaml");
  const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const career = path.join(profile, "career");
  if (fs.existsSync(career)) throw new Error("career e2e requires an unused career directory");
  fs.writeFileSync(file, `config_version: 2\nenabled: ${enabled}\nimport:\n  draft_ttl_days: 9\n`);
  try {
    await run();
  } finally {
    if (original) fs.writeFileSync(file, original);
    else fs.rmSync(file, { force: true });
    fs.rmSync(career, { recursive: true, force: true });
  }
}

async function save(page: Page) {
  await page.getByRole("button", { name: "保存档案", exact: true }).click();
  await expect(page.getByTestId("career-profile-form").getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
}

test("manual profile: save, wording, diff, restore, history cleanup and delete", async ({ page }) => {
  await withCareer(true, async () => {
    await page.goto("/me");
    await expect(page.getByTestId("career-card")).toBeVisible();
    await page.getByTestId("career-card").getByRole("link").click();
    await expect(page).toHaveURL(/\/career$/);
    const experience = page.getByTestId("career-experience");
    await experience.getByRole("button", { name: "添加经历", exact: true }).click();
    await experience.getByLabel("公司", { exact: true }).fill("Example Company");
    await experience.getByLabel("写法 1", { exact: true }).fill("Engineer");
    await experience.getByRole("button", { name: "添加要点", exact: true }).click();
    await experience.getByLabel("写法 1", { exact: true }).nth(1).fill("Built a reliable service");
    await save(page);
    await page.reload();
    await expect(experience.getByLabel("公司", { exact: true })).toHaveValue("Example Company");
    await expect(experience.getByLabel("写法 1", { exact: true }).nth(1)).toHaveValue("Built a reliable service");
    await experience.getByRole("button", { name: "另一种写法", exact: true }).nth(1).click();
    await experience.getByLabel("写法 2", { exact: true }).fill("Created a dependable service");
    await experience.getByRole("button", { name: "设为主写法", exact: true }).click();
    await save(page);
    const history = page.getByTestId("career-history");
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await history.getByRole("button", { name: "与当前档案对比" }).last().click();
    await expect(page.getByTestId("career-diff")).toContainText("Created a dependable service");
    await history.getByRole("button", { name: "恢复此版本" }).last().click();
    await expect(history.getByRole("listitem")).toHaveCount(3);
    await page.reload();
    await expect(experience.getByLabel("写法 1", { exact: true }).nth(1)).toHaveValue("Built a reliable service");
    await expect(experience.getByLabel("写法 2", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "清空历史", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await expect(history.getByRole("listitem")).toHaveCount(3);
    await page.getByRole("button", { name: "清空历史", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(history.getByText("暂无历史版本。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除全部职业档案数据", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByText("职业档案为空，添加条目开始编辑。", { exact: true })).toBeVisible();
    await expect(experience.getByLabel("公司", { exact: true })).toHaveCount(0);
  });
});

test("disabled career profile has no card and only an enablement note", async ({ page }) => {
  await withCareer(false, async () => {
    await page.goto("/me");
    await expect(page.getByTestId("career-card")).toHaveCount(0);
    await page.goto("/career");
    await expect(page.getByTestId("career-disabled")).toBeVisible();
    await expect(page.getByRole("link", { name: "打开工作流设置" })).toHaveAttribute("href", "/settings?tab=workflow");
    await expect(page.getByTestId("career-profile-form")).toHaveCount(0);
    const dir = process.env.E2E_PROFILE_DIR;
    if (!dir) throw new Error("E2E_PROFILE_DIR is required");
    expect(fs.existsSync(path.join(dir, "career"))).toBe(false);
  });
});

test("preview, extract, review, adopt, wording, restore and delete at mobile width", async ({ page }) => {
  await withCareer(true, async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/career");
    const extraction = page.getByTestId("career-extraction");
    const source = fs.readFileSync(new URL("../tests/fixtures/career/samples/en-research.txt", import.meta.url), "utf8");
    await extraction.getByTestId("career-extract-source").fill(source);
    await extraction.getByRole("button", { name: "生成预览", exact: true }).click();
    const preview = extraction.getByTestId("send-preview");
    const outbound = preview.getByTestId("outbound-text");
    await expect(outbound).toBeFocused();
    await expect(outbound).toHaveValue(/\[email\]/);
    await expect(outbound).toHaveValue(/\[phone\]/);
    await expect(preview.getByTestId("outbound-highlights").locator("mark")).toContainText(["Address: 00 Imaginary Lane, Fictionville", "Nationality: fictional"]);
    await preview.getByLabel("要移除的地址（可选）").fill("00 Imaginary Lane, Fictionville");
    await preview.getByRole("button", { name: "移除这些值", exact: true }).click();
    await expect(outbound).toHaveValue(/\[address\]/);
    await expect(outbound).toBeFocused();
    await outbound.fill((await outbound.inputValue()).replace("Published 2", "Published 3"));
    const confirmed = await outbound.inputValue();
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/career/extract"));
    await preview.getByRole("button", { name: "确认并提取", exact: true }).click();
    expect((await sent).postDataJSON()).toEqual({ origin: "resume", text: confirmed });
    await expect(extraction.getByTestId("career-draft-review")).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(extraction.getByText("草稿在 9 天后过期。", { exact: true })).toBeVisible();
    const review = extraction.getByTestId("career-draft-review");
    await expect(review.locator('[data-code="figure_missing"]')).toBeVisible();
    for (const select of await review.getByLabel("条目处理方式", { exact: true }).all()) await select.selectOption("new");
    await review.getByLabel("采用要点 2", { exact: true }).uncheck();
    await review.getByRole("button", { name: "采用所选条目", exact: true }).click();
    await expect(review).toHaveCount(0);
    const experience = page.getByTestId("career-experience");
    await expect(experience.getByLabel("公司", { exact: true })).toHaveValue("Fablemoss Research Ltd");
    await expect(experience.getByLabel("写法 1", { exact: true }).nth(1)).toHaveValue("Published 3 reproducible benchmarks.");
    await expect(page.getByTestId("career-custom_sections")).toContainText("Publications");
    await expect(page.getByTestId("career-custom_sections")).toContainText("Awards");
    await experience.getByRole("button", { name: "另一种写法", exact: true }).nth(1).click();
    await experience.getByLabel("写法 2", { exact: true }).fill("Made three benchmarks reproducible.");
    await save(page);
    const history = page.getByTestId("career-history");
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await history.getByRole("button", { name: "与当前档案对比" }).last().click();
    await expect(page.getByTestId("career-diff")).toContainText("Made three benchmarks reproducible.");
    await history.getByRole("button", { name: "恢复此版本" }).last().click();
    await expect(experience.getByLabel("写法 2", { exact: true })).toHaveCount(0);
    await expect(history.getByRole("listitem")).toHaveCount(3);
    await extraction.getByTestId("career-extract-source").fill(source.replace("Published 2", "Published 3"));
    await extraction.getByRole("button", { name: "生成预览", exact: true }).click();
    await extraction.getByTestId("outbound-send").click();
    await expect(extraction.getByTestId("career-draft-review")).toBeVisible({ timeout: 30_000 });
    await expect(extraction.getByText("建议匹配：Fablemoss Research Ltd · Research Engineer。", { exact: true })).toBeVisible();
    await extraction.getByLabel("条目处理方式", { exact: true }).first().selectOption("merge");
    await extraction.getByLabel("采用要点 2", { exact: true }).uncheck();
    await extraction.getByRole("button", { name: "采用所选条目", exact: true }).click();
    await expect(extraction.getByTestId("career-draft-review")).toHaveCount(0);
    await expect(experience.getByLabel("公司", { exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "删除全部职业档案数据", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByText("职业档案为空，添加条目开始编辑。", { exact: true })).toBeVisible();
    await expect(extraction.getByTestId("career-draft-review")).toHaveCount(0);
  });
});
