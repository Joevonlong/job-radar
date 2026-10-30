import { expect, test, type Page } from "./fixtures";

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
    ["/companies", "公司 · Job Radar"],
    ["/pipeline", "申请 · Job Radar"],
    ["/settings", "设置 · Job Radar"],
    ["/me", "我的画像 · Job Radar"],
    ["/sources/ai-usage", "AI 用量 · Job Radar"],
    ["/sources/logs", "操作日志 · Job Radar"],
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

test("the ticker pauses on hover and on focus, and stands still with reduced motion", async ({ page }) => {
  await open(page, "/");
  const ticker = page.locator(".jr-ticker");
  const track = ticker.locator(".jr-ticker__in");
  await expect(track).toHaveCSS("animation-play-state", "running");
  await ticker.hover();
  await expect(track).toHaveCSS("animation-play-state", "paused");
  await page.mouse.move(0, 0);
  await expect(track).toHaveCSS("animation-play-state", "running");
  await ticker.focus();
  await expect(track).toHaveCSS("animation-play-state", "paused");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(track).toHaveCSS("animation-name", "none");
  await expect(ticker.locator(".jr-ticker__copy")).toBeHidden();
  // the label stays put while the strip scrolls, and a scrollbar does not change the strip's height
  await expect(ticker.locator(".jr-ticker__lb")).toHaveCSS("position", "sticky");
  expect((await ticker.boundingBox())?.height).toBe(34);
});

test("the registry tables name their last column, and a jump tag is 24px high with its visible text as name", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, "/sources/registry");
  await expect(page.getByRole("columnheader", { name: "操作" }).first()).toBeAttached();

  await open(page, "/jobs?q=Clinical+NLP");
  await page.getByRole("link", { name: /Applied Scientist, Clinical NLP/ }).first().click();
  await expect(page.getByTestId("job-title")).toBeVisible();
  const tags = page.getByTestId("jump-tag");
  expect(await tags.count()).toBeGreaterThan(0);
  for (const tag of await tags.all()) {
    const box = await tag.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  }
  const first = tags.first();
  await expect(first).toHaveAccessibleName(((await first.textContent()) ?? "").trim());
  await expect(first).toHaveAccessibleDescription(/\S/);
});
