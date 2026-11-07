import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

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

test("create, preview, edit, include, layout, persist and write a letter", async ({ page }) => {
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
    await page.getByRole("link", { name: "简历文档", exact: true }).click();
    await page.getByLabel("文档标题（可选）").fill("Example résumé");
    await page.getByRole("button", { name: "从档案创建", exact: true }).click();
    await expect(page.getByTestId("document-editor")).toBeVisible();
    const frame = page.locator('iframe[title="文档预览"]');
    await expect(frame).toHaveAttribute("sandbox", "");
    const body = page.frameLocator('iframe[title="文档预览"]').locator("body");
    await expect(body).toContainText("Example Company");
    const content = page.getByTestId("document-experience");
    await content.getByRole("textbox", { name: "文本 1", exact: true }).fill("Created a dependable service");
    await expect(body).toContainText("Created a dependable service");
    await expect(content.getByTestId("document-edited")).toBeVisible();
    await content.getByRole("checkbox", { name: "包含", exact: true }).last().uncheck();
    await expect(body).not.toContainText("Helped the team ship");
    await page.getByRole("combobox", { name: "主题样式", exact: true }).selectOption("band");
    await expect(body).toHaveClass(/theme-band/);
    await page.getByRole("combobox", { name: "文档语言", exact: true }).selectOption("de");
    await expect(body).toContainText("Berufserfahrung");
    await page.getByRole("button", { name: "保存文档", exact: true }).click();
    await expect(page.getByTestId("document-editor").getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
    await page.reload();
    await expect(content.getByRole("textbox", { name: "文本 1", exact: true })).toHaveValue(
      "Created a dependable service",
    );
    await expect(content.getByRole("checkbox", { name: "包含", exact: true }).last()).not.toBeChecked();
    await expect(page.getByRole("combobox", { name: "主题样式", exact: true })).toHaveValue("band");
    await expect(page.getByRole("combobox", { name: "文档语言", exact: true })).toHaveValue("de");
    await page.getByRole("tab", { name: "求职信", exact: true }).click();
    await page.getByRole("button", { name: "添加求职信", exact: true }).click();
    await page.getByLabel("主题", { exact: true }).fill("Application for Engineer");
    await page.getByRole("button", { name: "添加条目", exact: true }).click();
    await page.getByRole("textbox", { name: "文本 1", exact: true }).fill("I would like to join your team.");
    await expect(body).toContainText("Application for Engineer");
    await page.getByRole("button", { name: "保存文档", exact: true }).click();
    await expect(page.getByTestId("document-editor").getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "求职信", exact: true }).click();
    await expect(page.getByLabel("主题", { exact: true })).toHaveValue("Application for Engineer");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.documentElement.classList.remove("light");
      document.documentElement.classList.add("dark");
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("tab", { name: "预览", exact: true }).click();
    await expect(frame).toBeVisible();
    await expect(frame).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("career-builder-mobile-dark.png") });
  });
});

test("disabled document pages only show the enablement note", async ({ page }) => {
  await withCareer(false, async () => {
    for (const url of ["/career/documents", "/career/documents/doc_aaaaaaaaaa"]) {
      await page.goto(url);
      await expect(page.getByTestId("career-disabled")).toBeVisible();
      await expect(page.getByRole("link", { name: "打开工作流设置" })).toHaveAttribute(
        "href",
        "/settings?tab=workflow",
      );
      await expect(page.getByTestId("document-editor")).toHaveCount(0);
    }
    expect(fs.existsSync(path.join(process.env.E2E_PROFILE_DIR!, "career"))).toBe(false);
  });
});

test("the career item follows the switch without a reload and hides when career.yaml breaks", async ({ page }) => {
  await withCareer(false, async () => {
    const file = path.join(process.env.E2E_CONFIG_DIR!, "career.yaml");
    const sidebar = page.getByRole("complementary", { name: "侧栏" });
    const hrefs = () => sidebar.getByRole("navigation", { name: "主导航" }).getByRole("link").evaluateAll(
      (links) => links.map((link) => link.getAttribute("href")),
    );
    const defaults = ["/", "/jobs", "/companies", "/favorites", "/pipeline", "/sources", "/insights", "/settings", "/me", "/interests"];
    await page.goto("/settings?tab=workflow");
    expect(await hrefs()).toEqual(defaults);
    await page.evaluate(() => Object.assign(window, { sameDocument: true }));
    const card = page.getByTestId("settings-card-career");
    await card.getByRole("switch", { name: "开启职业档案" }).click();
    await card.getByRole("button", { name: "保存", exact: true }).click();
    await expect(sidebar.getByRole("link", { name: "职业档案", exact: true })).toBeVisible();
    expect(await hrefs()).toEqual([...defaults.slice(0, 5), "/career", ...defaults.slice(5)]);
    expect(await page.evaluate(() => "sameDocument" in window)).toBe(true);
    await sidebar.getByRole("link", { name: "职业档案", exact: true }).click();
    await expect(page).toHaveURL(/\/career$/);
    fs.writeFileSync(file, "config_version: 2\nenabled: [\n");
    await page.goto("/jobs");
    await expect(sidebar.getByRole("link", { name: "职业档案", exact: true })).toHaveCount(0);
    expect(await hrefs()).toEqual(defaults);
  });
});
