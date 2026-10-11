import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, path = "/") {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test("the first Tab stop is a skip link that shows on focus and moves the focus to the page", async ({ page }) => {
  await open(page, "/jobs");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "跳到主要内容" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();
});

test("every page has its own title in the form 'Page · Job Radar'", async ({ page }) => {
  const titles: Array<[string, string]> = [
    ["/", "今日 · Job Radar"],
    ["/jobs", "岗位 · Job Radar"],
    ["/pipeline", "申请 · Job Radar"],
    ["/settings", "设置 · Job Radar"],
    ["/me", "我的画像 · Job Radar"],
    ["/sources/ai-usage", "AI 用量 · Job Radar"],
  ];
  for (const [path, title] of titles) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
  }
});

test("the settings tab list holds only tabs, and quick filters are links without aria-pressed", async ({ page }) => {
  await open(page, "/settings");
  const tablist = page.getByRole("tablist");
  await expect(tablist.getByRole("tab").first()).toBeVisible();
  await expect(tablist.getByRole("separator")).toHaveCount(0);

  await open(page, "/jobs");
  const toggle = page.getByTestId("toggle-filtered");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toHaveAttribute("aria-pressed", /.*/);
});

test("the command palette title is not in the page while the palette is closed, and Ctrl+K from nowhere returns the focus to the search button", async ({ page }) => {
  await open(page, "/jobs");
  await expect(page.getByRole("heading", { name: "命令面板" })).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeHidden();
  await expect(page.getByRole("button", { name: /^搜索/ })).toBeFocused();
});
