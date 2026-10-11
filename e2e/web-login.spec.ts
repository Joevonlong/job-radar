import { expect, test } from "@playwright/test";

/**
 * The optional web password against the production build (playwright.config.ts sets JOB_RADAR_WEB_PASSWORD). A request
 * with a forwarding header comes "from elsewhere" (as through tailscale serve); without one, from this machine.
 */
const PASSWORD = process.env.E2E_WEB_PASSWORD ?? "";
const REMOTE = { "x-forwarded-for": "100.64.0.2" };

// "sign out everywhere" ends every session on the server: the tests of this file must not run side by side
test.describe.configure({ mode: "serial" });

test.describe("from elsewhere, without a session", () => {
  test("a page goes to the login page, everything else gets 401", async ({ request }) => {
    const page = await request.get("/jobs?view=table", { headers: { ...REMOTE, accept: "text/html" }, maxRedirects: 0 });
    expect(page.status()).toBe(303);
    expect(page.headers().location).toBe("/login?next=%2Fjobs%3Fview%3Dtable");

    expect((await request.get("/api/search?q=x", { headers: REMOTE })).status()).toBe(401);
    // a Server Action posted to the login page (the page itself is open for GET only)
    const action = await request.post("/login", { headers: { ...REMOTE, "next-action": "0000", accept: "text/x-component" }, data: "[]" });
    expect(action.status()).toBe(401);
    const rsc = await request.get("/jobs", { headers: { ...REMOTE, rsc: "1", "next-router-prefetch": "1" } });
    expect(rsc.status()).toBe(401);
    // the health check stays open (compose healthcheck, uptime checks)
    expect((await request.get("/api/health", { headers: REMOTE })).status()).not.toBe(401);
  });
});

test("from elsewhere: sign in, use the dashboard, sign out", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: REMOTE });
  const page = await context.newPage();
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login\?next=%2Fjobs$/);
  await expect(page.getByTestId("login-page")).toBeVisible();
  // plain http from elsewhere: the warning
  await expect(page.getByTestId("login-insecure")).toBeVisible();
  // the locked shell shows nothing of the data
  await expect(page.getByTestId("cycle-status")).toHaveCount(0);
  await expect(page.getByTestId("language-menu")).toHaveCount(0);

  await page.getByTestId("login-password").fill("not the password");
  await page.getByTestId("login-submit").click();
  // the answer clears the field and fills the (always present) live region
  await expect(page.getByTestId("login-error")).toHaveText(/\S/);
  await expect(page.getByTestId("login-password")).toHaveValue("");

  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/jobs$/);
  const cookie = (await context.cookies()).find((c) => c.name === "jr_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  await expect(page.getByTestId("sign-out").first()).toBeAttached();

  // the session also carries the dashboard's own requests (API, client-side navigation)
  expect((await page.request.get("/api/search?q=x")).status()).not.toBe(401);

  await page.goto("/login");
  await expect(page).toHaveURL(/\/$|\/jobs/);

  await page.goto("/jobs");
  const signOut = page.getByTestId("sign-out").filter({ visible: true }).first();
  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login\?next=%2Fjobs$/);
  await context.close();
});

test("from this machine: no login, no sign-out, no warning", async ({ page }) => {
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.getByTestId("sign-out")).toHaveCount(0);
  await expect(page.getByTestId("access-banner")).toHaveCount(0);
});

test("sign out everywhere: the settings button ends every session, the other browser's too", async ({ browser }) => {
  const signIn = async () => {
    const context = await browser.newContext({ extraHTTPHeaders: REMOTE });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();
    await expect(page).not.toHaveURL(/\/login/);
    return { context, page };
  };
  const first = await signIn();
  const second = await signIn();
  expect((await second.page.request.get("/api/search?q=x")).status()).not.toBe(401);

  await first.page.goto("/settings");
  await expect(first.page.getByTestId("sessions-card")).toBeVisible();
  await first.page.getByTestId("sign-out-everywhere").click();
  await expect(first.page).toHaveURL(/\/login$/);
  // the other browser still holds its cookie, and it no longer counts
  expect((await second.page.request.get("/api/search?q=x")).status()).toBe(401);
  await first.context.close();
  await second.context.close();
});
