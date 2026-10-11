import { expect, test } from "@playwright/test";

/**
 * The host allowlist (DNS rebinding protection) and the security headers, against the production build. Requests only;
 * nothing is written.
 */
test("a request addressed to a foreign host name or from a foreign origin is refused with 421", async ({ request }) => {
  const foreignHost = await request.get("/api/health", { headers: { host: "rebound.evil.example:3000" } });
  expect(foreignHost.status()).toBe(421);
  expect(await foreignHost.text()).toContain("JOB_RADAR_ALLOWED_HOSTS");

  const foreignOrigin = await request.post("/settings", { headers: { origin: "http://rebound.evil.example:3000" }, data: "" });
  expect(foreignOrigin.status()).toBe(421);

  // another allowed host is still another site: a state-changing request must come from the address it is sent to
  const otherTailnetMachine = await request.post("/settings", { headers: { origin: "https://other.example-tailnet.ts.net" }, data: "" });
  expect(otherTailnetMachine.status()).toBe(421);
});

test("the dashboard's own requests pass and carry the security headers", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).not.toBe(421);
  const page = await request.get("/jobs");
  expect(page.ok()).toBe(true);
  const headers = page.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("same-origin");
  expect(headers["x-powered-by"]).toBeUndefined();
});
