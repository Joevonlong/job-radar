import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

/**
 * Résumé tailoring against the seeded "LLM Engineer" job. The e2e runner stands in for the ai-worker: the wording step
 * returns one rewrite with a duty the profile lacks and one supported rewrite of the same entry's second bullet.
 */
test.describe.configure({ mode: "serial" });

async function withCareer(enabled: boolean, run: () => Promise<void>): Promise<void> {
  const dir = process.env.E2E_CONFIG_DIR;
  const profile = process.env.E2E_PROFILE_DIR;
  if (!dir || !profile) throw new Error("E2E_CONFIG_DIR and E2E_PROFILE_DIR are required");
  const file = path.join(dir, "career.yaml");
  const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const career = path.join(profile, "career");
  if (fs.existsSync(career)) throw new Error("career e2e requires an unused career directory");
  fs.writeFileSync(file, `config_version: 2\nenabled: ${enabled}\n`);
  try {
    await run();
  } finally {
    if (original) fs.writeFileSync(file, original);
    else fs.rmSync(file, { force: true });
    fs.rmSync(career, { recursive: true, force: true });
  }
}

test("pick a job, preview, generate, review suggestions, confirm a mark and save it back", async ({ page }) => {
  await withCareer(true, async () => {
    await page.goto("/career");
    const experience = page.getByTestId("career-experience");
    await experience.getByRole("button", { name: "添加经历", exact: true }).click();
    await experience.getByLabel("公司", { exact: true }).fill("Example Company");
    await experience.getByLabel(/^开始日期/).fill("2024");
    await experience.getByLabel("写法 1", { exact: true }).fill("Engineer");
    for (const text of ["Built a reliable service", "Helped the team ship"]) {
      await experience.getByRole("button", { name: "添加要点", exact: true }).click();
      await experience.getByLabel("写法 1", { exact: true }).last().fill(text);
    }
    await page.getByRole("button", { name: "保存档案", exact: true }).click();
    await expect(page.getByTestId("career-profile-form").getByRole("status")).toContainText("已保存");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/career/tailor");
    const tailor = page.getByTestId("career-tailor");
    await expect(tailor.getByRole("button", { name: "确认并生成" })).toHaveCount(0);
    await expect(tailor.getByRole("button", { name: "预览将要发送的内容" })).toBeDisabled();
    await tailor.getByPlaceholder("职位或公司").fill("LLM Engineer");
    await tailor.getByRole("button", { name: "搜索岗位", exact: true }).click();
    await tailor.getByRole("button", { name: /^选择 .* 的 LLM Engineer$/ }).first().click();
    await expect(tailor.getByTestId("tailor-job")).toContainText("LLM Engineer");
    await tailor.getByRole("button", { name: "添加要求", exact: true }).click();
    await tailor.getByLabel("要求 1", { exact: true }).fill("Mention reliability work");
    await tailor.getByRole("button", { name: "预览将要发送的内容" }).click();
    const preview = tailor.getByTestId("tailor-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId("tailor-block").filter({ hasText: "Mention reliability work" })).toHaveCount(1);
    await expect(preview.getByTestId("tailor-block").filter({ hasText: "Built a reliable service" }).first()).toBeVisible();
    await expect(preview.getByTestId("tailor-jd")).not.toBeEmpty();
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/career/tailor") && request.method() === "POST");
    await preview.getByRole("button", { name: "确认并生成", exact: true }).click();
    const body = (await sent).postDataJSON() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["doc_id", "jobId", "mode", "outbound_hash", "over_pages", "with_letter"]);
    expect(JSON.stringify(body)).not.toContain("reliab");

    const review = tailor.getByTestId("proposal-review");
    const items = review.getByTestId("proposal-wording").getByTestId("proposal-item");
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    await expect(review.getByTestId("proposal-structure")).toContainText("这里没有提议。");
    const unsupported = items.filter({ hasText: "cross-functional" });
    await expect(unsupported.getByTestId("claim-line").filter({ hasText: "职责" })).toContainText("Led a cross-functional team");
    await expect(unsupported.getByTestId("proposal-diff").locator("ins", { hasText: "cross-functional" })).toHaveCount(1);
    await unsupported.getByRole("button", { name: "接受", exact: true }).click();
    await expect(items).toHaveCount(1);
    await items.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(review).toContainText("没有待审核的提议。");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await tailor.getByRole("link", { name: "打开文档", exact: true }).click();
    await expect(page.getByTestId("document-editor")).toBeVisible();
    const content = page.getByTestId("document-experience");
    await expect(content.getByRole("textbox", { name: "文本 1", exact: true })).toHaveValue("Led a cross-functional team of eight engineers");
    await expect(content.getByRole("textbox", { name: "文本 2", exact: true })).toHaveValue("Helped the team ship");
    const mark = content.getByTestId("claim-mark");
    await expect(mark).toHaveText("档案里没有");
    await expect(page.frameLocator('iframe[title="文档预览"]').locator("body")).not.toContainText("档案里没有");
    await expect(page.getByTestId("tailor-shrink")).toBeDisabled();
    await expect(page.getByText("页数未知。", { exact: true })).toBeVisible();
    const marks = content.getByTestId("claim-marks").filter({ has: page.getByTestId("claim-mark") });
    await marks.getByRole("button", { name: "存回档案", exact: true }).click();
    await expect(marks.getByRole("alert")).toContainText("先确认或删掉");
    const confirm = marks.getByRole("button", { name: "确认", exact: true });
    await expect(confirm.first()).toBeVisible();
    for (let left = await confirm.count(); left > 0; left--) {
      await confirm.first().click();
      await expect(confirm).toHaveCount(left - 1);
    }
    await expect(mark).toHaveText("已确认");
    await marks.getByRole("button", { name: "存回档案", exact: true }).click();
    await expect(content.getByTestId("claim-mark")).toHaveCount(0);

    await page.goto("/career");
    await expect(page.getByTestId("career-experience").getByLabel("写法 2", { exact: true })).toHaveValue("Led a cross-functional team of eight engineers");
  });
});

test("disabled tailoring page only shows the enablement note", async ({ page }) => {
  await withCareer(false, async () => {
    await page.goto("/career/tailor?job=1");
    await expect(page.getByTestId("career-disabled")).toBeVisible();
    await expect(page.getByTestId("career-tailor")).toHaveCount(0);
    expect(fs.existsSync(path.join(process.env.E2E_PROFILE_DIR!, "career"))).toBe(false);
  });
});
