import { expect, test, type Page } from "./fixtures";

/**
 * The agent activity page (/settings/agents/activity) on the dashboard seed, which holds fifty-seven fictional audit rows over
 * about eight days (stdio and two sample tokens, one revoked, every result). Read only, so it runs in parallel with the other
 * specs. Selectors use test ids: the UI is Chinese by default.
 */
async function open(page: Page, query = "") {
  await page.goto(`/settings/agents/activity${query}`);
  await expect(page.getByTestId("agents-activity-page")).toBeVisible();
}

const rowIds = (page: Page) => page.getByTestId("agents-activity-row").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-call-id") ?? ""));

test("opens on the default range with a summary, the table and the sub-navigation", async ({ page }) => {
  await open(page);
  await expect(page).toHaveTitle("Agent 活动 · Job Radar");
  await expect(page.getByTestId("agents-subnav").locator('[aria-current="location"]')).toHaveAttribute("data-subnav", "activity");
  await expect(page.getByTestId("agents-activity-filter-range")).toHaveValue("7d");
  expect((await rowIds(page)).length).toBeGreaterThan(20);
  await expect(page.getByTestId("agents-activity-total")).toContainText(/\d/);
  await expect(page.getByTestId("agents-activity-legend").first()).toBeVisible();
});

test("the filters narrow the list alone and together, and live in the URL", async ({ page }) => {
  await open(page, "?range=all");
  const all = (await rowIds(page)).length;

  await page.getByTestId("agents-activity-filter-result").selectOption("error");
  await page.getByTestId("agents-activity-apply").click();
  await expect(page).toHaveURL(/result=error/);
  const errors = await page.getByTestId("agents-activity-table").getByTestId("agents-activity-result").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-outcome")));
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.length).toBeLessThan(all);
  expect(new Set(errors)).toEqual(new Set(["error"]));

  await page.getByTestId("agents-activity-filter-connection").selectOption("stdio");
  await page.getByTestId("agents-activity-apply").click();
  await expect(page).toHaveURL(/connection=stdio/);
  const after = (await rowIds(page)).length;
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(errors.length);

  await page.getByTestId("agents-activity-filter-tool").selectOption("get_job");
  await page.getByTestId("agents-activity-apply").click();
  await expect(page).toHaveURL(/tool=get_job/);
  await expect(page.getByTestId("agents-activity-filter-result")).toHaveValue("error");
  for (const cell of await page.getByTestId("agents-activity-table").locator("tbody tr td:nth-child(3)").allTextContents()) expect(cell).toContain("get_job");

  await page.getByTestId("agents-activity-clear").click();
  await expect(page).toHaveURL(/\/settings\/agents\/activity$/);
});

test("the connection filter lists a revoked token and its calls are marked", async ({ page }) => {
  await open(page, "?range=all");
  const option = page.getByTestId("agents-activity-filter-connection").locator("option", { hasText: "Sample old notebook" });
  await expect(option).toHaveCount(1);
  await page.getByTestId("agents-activity-filter-connection").selectOption({ label: await option.innerText() });
  await page.getByTestId("agents-activity-apply").click();
  const table = page.getByTestId("agents-activity-table");
  await expect(table.getByTestId("agents-activity-row").first()).toBeVisible();
  for (const text of await table.locator("tbody tr td:nth-child(2)").allTextContents()) expect(text).toContain("Sample old notebook");
  await expect(table.getByText(/已吊销/).first()).toBeVisible();
});

test("keyset paging gives every call once, newest first, and the way back", async ({ page }) => {
  await open(page, "?range=all");
  const first = await rowIds(page);
  expect(first).toHaveLength(50);
  await page.getByTestId("agents-activity-older").click();
  await expect(page).toHaveURL(/before=/);
  await expect(page.getByTestId("agents-activity-older")).toHaveCount(0);
  const second = await rowIds(page);
  expect(second.length).toBeGreaterThan(0);
  expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  expect(Number(second[0])).not.toBe(Number(first[0]));
  await page.getByTestId("agents-activity-newest").click();
  await expect(page).toHaveURL(/range=all$/);
  expect(await rowIds(page)).toEqual(first);
});

test("a filter with no match shows the filtered empty state with a way to clear it", async ({ page }) => {
  await open(page, "?tool=no_such_tool");
  await expect(page.getByTestId("agents-activity-empty-filtered")).toBeVisible();
  await page.getByTestId("agents-activity-empty-filtered").getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/agents\/activity$/);
  expect((await rowIds(page)).length).toBeGreaterThan(0);
});

test("a target that resolves to a job links to it", async ({ page }) => {
  await open(page, "?tool=get_job&range=all");
  const link = page.getByTestId("agents-activity-table").getByTestId("agents-activity-target").getByRole("link").first();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/jobs\/\d+$/);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});

test("the last call on the access page leads here", async ({ page }) => {
  await page.goto("/settings/agents");
  await page.getByTestId("agents-last-call").getByRole("link").click();
  await expect(page.getByTestId("agents-activity-page")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("calls are cards and the page does not scroll sideways", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("agents-activity-table")).toBeHidden();
    await expect(page.getByTestId("agents-activity-card").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
