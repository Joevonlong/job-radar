import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * languages. The e2e configuration is the Chinese one of an existing install (tests/fixtures/config/defaults/language.yaml):
 * these tests change language.yaml (through the settings form or on disk, the web app reads it fresh) and put it back after each test.
 */
const CONFIG_DIR = process.env.E2E_CONFIG_DIR ?? "";
const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");
const languageFile = () => path.join(CONFIG_DIR, "language.yaml");
const readLanguage = () => fs.readFileSync(languageFile(), "utf8");
const writeLanguage = (edit: (text: string) => string) => fs.writeFileSync(languageFile(), edit(fs.readFileSync(path.join(DEFAULTS_DIR, "language.yaml"), "utf8")));

test.describe.configure({ mode: "serial" });

test.afterEach(() => {
  fs.copyFileSync(path.join(DEFAULTS_DIR, "language.yaml"), languageFile());
});

async function openJob(page: Page, title: string) {
  await page.goto(`/jobs?q=${encodeURIComponent(title)}&filtered=true`);
  await page.getByRole("link", { name: title }).first().click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("load");
}

test("the settings language block changes the interface language of a browser without a choice", async ({ page, browser }) => {
  await page.goto("/settings?tab=ui");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const card = page.getByTestId("settings-card-language");
  await expect(card.getByRole("heading", { name: "语言" })).toBeVisible();
  const select = card.getByRole("combobox", { name: "默认界面语言" });
  await expect(select).toHaveValue("zh");
  // the interface languages are offered by their own names
  await expect(select.locator("option")).toHaveText(["English", "中文"]);
  await expect(card.getByRole("combobox", { name: "Telegram 语言" })).toHaveValue("");
  await select.selectOption("en");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(readLanguage).toContain("default_locale: en");
  // the comments of the file survive the save
  expect(readLanguage()).toContain("# Test fixture");

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto("/settings?tab=ui");
  await expect(other.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(other.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(other.getByTestId("settings-card-language").getByRole("combobox", { name: "Default interface language" })).toHaveValue("en");
  await fresh.close();
});

test("a wrong language code is refused with a field error, the file stays", async ({ page }) => {
  await page.goto("/settings?tab=ui");
  const card = page.getByTestId("settings-card-language");
  await card.getByRole("textbox", { name: "AI 语言" }).fill("Chinese");
  // the browser flags it while typing and keeps Save off, so nothing is sent
  await expect(card.getByText("语言代码，如 en、zh、de、pt-BR")).toBeVisible();
  await expect(card.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(readLanguage()).toContain("output: zh");
});

test("the language button switches to the other language by its own name", async ({ page }) => {
  await page.goto("/jobs");
  const button = page.getByRole("button", { name: "切换语言" });
  await expect(button).toHaveText("English");
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  const back = page.getByRole("button", { name: "Switch language" });
  await expect(back).toHaveText("中文");
  await back.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("AI texts carry their own language: the reasons are tagged zh-CN in the English interface", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
  await openJob(page, "LLM Engineer");
  await expect(page.getByTestId("fit-list")).toHaveAttribute("lang", "zh-CN");
  const tag = page.locator("section", { has: page.locator("#h-fit") }).getByTestId("language-tag");
  await expect(tag).toHaveText("中文");
  await expect(tag).toHaveAttribute("title", "The AI wrote the fit reasons and gaps in Chinese; they are not translated.");
  await expect(page.getByRole("tab", { name: "Chinese translation" })).toBeVisible();
});

test("the translation target: tab and button name it, a JD already in it has none", async ({ page, context, baseURL }) => {
  writeLanguage((text) => text.replace("target: zh", "target: en"));
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
  // an English JD: nothing to translate into English
  await openJob(page, "Machine Learning Engineer, Perception");
  await expect(page.getByTestId("action-translate")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /translation/ })).toHaveCount(0);
  // a German JD is translated into English
  await openJob(page, "Data Engineer");
  await expect(page.getByTestId("action-translate")).toHaveText("Translate to English");
  await page.getByRole("tab", { name: "English translation" }).click();
  await expect(page.getByTestId("translate-button")).toContainText("Translate to English");
});

test("scoring criteria: the AI tab says how many scores a change re-scores, the criteria are saved", async ({ page }) => {
  const aiFile = path.join(CONFIG_DIR, "ai.yaml");
  const original = fs.readFileSync(aiFile, "utf8");
  try {
    await page.goto("/settings?tab=ai");
    const card = page.getByTestId("settings-card-ai");
    await expect(card.getByRole("heading", { name: "打分标准" })).toBeVisible();
    await expect(page.getByTestId("criteria-impact")).toHaveCount(0);
    const priorities = card.getByLabel("最看重", { exact: true });
    await priorities.fill("落地的机器学习项目优先");
    await priorities.press("Enter");
    const impact = page.getByTestId("criteria-impact");
    await expect(impact).toBeVisible();
    await expect(impact).toContainText("当前分数重新打分");
    await card.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => fs.readFileSync(aiFile, "utf8")).toContain("落地的机器学习项目优先");
    await expect(page.getByTestId("criteria-impact")).toHaveCount(0);
  } finally {
    fs.writeFileSync(aiFile, original);
  }
});
