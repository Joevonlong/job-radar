import { expect, test, type Page } from "./fixtures";

/** Load a page and wait until client JS is attached, so clicks are not lost to pre-hydration. */
async function open(page: Page, path = "/") {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

const ZH_NAV = ["今日", "岗位", "公司", "收藏", "申请", "来源", "统计", "设置", "我的画像", "感兴趣清单"];
const EN_NAV = ["Today", "Jobs", "Companies", "Favorites", "Pipeline", "Sources", "Insights", "Settings", "My profile", "Interests"];
/** The links carry count badges after the label ("Jobs18"): match the label at the start. */
const startsWith = (labels: string[]) => labels.map((label) => new RegExp(`^${label}`));

test("home renders with Chinese navigation by default", async ({ page }) => {
  await open(page);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("link")).toHaveText(startsWith(ZH_NAV));
  await expect(page.getByRole("heading", { level: 1, name: "今日" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(nav.getByRole("link", { name: "今日" })).toHaveAttribute("aria-current", "page");
});

test("the sidebar is terminal black with the settings group and the cycle status, in both themes", async ({ page }) => {
  await open(page);
  const side = page.locator("aside");
  await expect(side).toHaveCSS("background-color", "rgb(17, 17, 17)");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("group", { name: "// 设置" }).getByRole("link")).toHaveText(["设置", "我的画像", "感兴趣清单"]);
  // the current page is amber inverse
  await expect(nav.getByRole("link", { name: "今日" })).toHaveCSS("background-color", "rgb(255, 176, 0)");
  const status = page.getByTestId("cycle-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("data-state", /idle|running|failed/);

  await page.getByRole("button", { name: "切换深浅主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  // the terminal theme uses the deeper terminal black
  await expect(side).toHaveCSS("background-color", "rgb(5, 5, 4)");
});

test("the cycle status API answers with the shape the sidebar parses", async ({ request }) => {
  const response = await request.get("/api/shell/status");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { state: string; timezone: string };
  expect(["idle", "running", "failed"]).toContain(body.state);
  expect(body.timezone).toBeTruthy();
});

test("theme toggle switches paper (light, default) to terminal (dark) and persists after reload", async ({ page }) => {
  await open(page);
  const html = page.locator("html");
  await expect(html).toHaveClass(/light/);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(241, 240, 232)");
  await expect(page.getByRole("button", { name: "切换深浅主题" })).toContainText("纸面");

  await page.getByRole("button", { name: "切换深浅主题" }).click();
  await expect(html).toHaveClass(/dark/);
  await expect(html).not.toHaveClass(/light/);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(11, 11, 10)");
  await expect(page.getByRole("button", { name: "切换深浅主题" })).toContainText("终端");

  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await expect(html).not.toHaveClass(/light/);
});

test("language toggle switches to English and persists after reload", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "切换语言" }).click();

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link")).toHaveText(startsWith(EN_NAV));
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link")).toHaveText(startsWith(EN_NAV));
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
});

test("all routes render a heading and highlight their nav entry", async ({ page }) => {
  const routes: [string, string][] = [
    ["/", "今日"],
    ["/jobs", "岗位"],
    ["/companies", "公司"],
    ["/pipeline", "申请"],
    ["/sources", "来源"],
    ["/insights", "统计"],
    ["/settings", "设置"],
    ["/me", "我的画像"],
    ["/interests", "感兴趣清单"],
  ];
  for (const [path, title] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator('nav a[aria-current="page"]')).toHaveCount(1);
  }
});

test("leaving the viewport-fitted pipeline restores document scrolling", async ({ page }) => {
  await open(page, "/pipeline");
  const main = page.getByRole("main");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(page.locator("[data-fit-viewport]")).toHaveCount(1);
  await expect(main).toHaveCSS("overflow-y", "auto");

  for (const [label, path] of [["岗位", "/jobs"], ["设置", "/settings"]]) {
    await nav.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator("[data-fit-viewport]")).toHaveCount(0);
    await expect(main).toHaveCSS("overflow-y", "visible");
  }
});

test("an unknown job id shows the not-found state inside the shell", async ({ page }) => {
  await page.goto("/jobs/999999999");
  await expect(page.getByTestId("job-not-found")).toBeVisible();
  await expect(page.locator('nav a[aria-current="page"]')).toHaveCount(1);
});

test("command palette opens with Ctrl+K and navigates on Enter", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "命令面板" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("统计");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/insights$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "统计" })).toBeVisible();
});

test("command palette opens from the top bar button and Esc gives the focus back to it", async ({ page }) => {
  await open(page);
  const trigger = page.getByRole("button", { name: "搜索" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(13);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("command palette job results carry the score as 88/100 text", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("engineer");
  const score = page.getByTestId("palette-score").first();
  await expect(score).toBeVisible();
  await expect(score).toHaveText(/^(\d+\/100(\+\d+)?|—)$/);
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("navigation collapses into a sheet and the page does not scroll horizontally", async ({ page }) => {
    await open(page);
    const menu = page.getByRole("button", { name: "打开导航菜单" });
    await expect(menu).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeHidden();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);

    // phone top bar: terminal black
    await expect(page.getByTestId("topbar")).toHaveCSS("background-color", "rgb(17, 17, 17)");
    // the status dot: its name starts with the word drawn on it (nothing is drawn while all is well)
    const dot = page.getByTestId("topbar").getByTestId("cycle-status-dot");
    await expect(dot).toBeVisible();
    const word = ((await dot.textContent()) ?? "").replace("●", "").trim();
    const dotName = (await dot.getAttribute("aria-label")) ?? "";
    expect(dotName.startsWith(word === "" ? "处理轮状态：" : `${word} · `)).toBe(true);
    // the theme and language buttons stay on the bar
    await expect(page.getByTestId("topbar").getByRole("button", { name: "切换深浅主题" })).toBeVisible();
    await expect(page.getByTestId("topbar").getByRole("button", { name: "切换语言" })).toBeVisible();

    await menu.click();
    const nav = page.getByRole("dialog").getByRole("navigation", { name: "主导航" });
    await expect(page.getByRole("dialog").getByTestId("cycle-status")).toBeVisible();
    await expect(nav.getByRole("link")).toHaveText(startsWith(ZH_NAV));
    await nav.getByRole("link", { name: "岗位" }).click();
    await expect(page).toHaveURL(/\/jobs$/);
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
