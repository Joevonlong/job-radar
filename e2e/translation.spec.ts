import { expect, test, type Page } from "./fixtures";

/**
 * The translation tab of the job page on the seeded e2e database. "Forward Deployed Engineer"
 * (Quillfeather Labs) has a fictional cached translation; "LLM Engineer" (Brumbach Analytics) has none.
 * The translate button is not clicked here: that would call a real AI provider.
 */

async function openJob(page: Page, name: RegExp) {
  await page.goto("/jobs");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
}

test.describe("translation tab", () => {
  test("shows the cached translation with the signal sentence highlighted", async ({ page }) => {
    await openJob(page, /Forward Deployed Engineer/);
    await page.getByRole("tab", { name: "中文翻译" }).click();
    const body = page.getByTestId("translation-body");
    await expect(body).toBeVisible();
    await expect(body).toHaveAttribute("lang", "zh-CN");
    await expect(body.getByRole("heading", { name: "我们提供" })).toBeVisible();
    await expect(body.locator("mark")).toContainText("薪资范围");
    await expect(page.getByTestId("translation-note")).toContainText("机器翻译");
    await expect(page.getByTestId("translate-button")).toHaveCount(0);
    // the original stays one tab away and is not touched
    await page.getByRole("tab", { name: /^原文/ }).click();
    await expect(page.getByTestId("jd-body")).toContainText("What we offer");
  });

  test("a job without a translation offers the translate button", async ({ page }) => {
    await openJob(page, /LLM Engineer/);
    await page.getByRole("tab", { name: "中文翻译" }).click();
    await expect(page.getByTestId("translation-none")).toBeVisible();
    await expect(page.getByTestId("translate-button")).toBeEnabled();
    await expect(page.getByTestId("translate-button")).toContainText("翻译成中文");
  });
});

test.describe("English and light theme", () => {
  test("renders the tab in English", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL ?? "http://127.0.0.1:3100" }]);
    await page.addInitScript(() => localStorage.setItem("theme", "light"));
    await openJob(page, /Forward Deployed Engineer/);
    await page.getByRole("tab", { name: "Chinese translation" }).click();
    await expect(page.getByTestId("translation-note")).toContainText("machine translated");
    await expect(page.getByText("Highlight = translation of a quoted signal sentence")).toBeVisible();
  });
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the tab does not scroll horizontally", async ({ page }) => {
    for (const name of [/Forward Deployed Engineer/, /LLM Engineer/]) {
      await openJob(page, name);
      await page.getByRole("tab", { name: "中文翻译" }).click();
      await expect(page.getByTestId("translation-panel")).toBeVisible();
      const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(widths[0]).toBeLessThanOrEqual(widths[1] ?? 390);
    }
  });
});
