import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, test, waitForServerActions, type Page } from "./fixtures";
import { rootIdForCycle } from "../src/lib/activity/ids";

function connect() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is required");
  return postgres(url, { max: 1, onnotice: () => {} });
}
async function seedCycle(page: Page) {
  await waitForServerActions(page);
  const sql = connect();
  try {
    const [cycle] = await sql<{ id: string }[]>`select id from cycles where summary_json ->> 'seed'='true' order by started_at desc limit 1`;
    if (!cycle) throw new Error("seed cycle missing");
    return Number(cycle.id);
  } finally { await sql.end({ timeout: 5 }); }
}
async function openCycle(page: Page) {
  const cycleId = await seedCycle(page);
  await page.goto(`/sources/logs?cycle=${cycleId}&range=custom&from=2000-01-01&to=2000-01-01`);
  await expect(page).toHaveURL(new RegExp(`/sources/logs/${rootIdForCycle(cycleId)}$`));
}

test("sources navigation and command palette expose activity logs in both search languages", async ({ page }) => {
  await page.goto("/sources");
  await page.getByTestId("activity-log-subnav").click();
  await expect(page).toHaveURL(/\/sources\/logs$/);
  await expect(page.getByTestId("activity-log-subnav")).toHaveAttribute("aria-current", "location");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option")).toHaveCount(13);
  for (const text of ["日志", "logs"]) {
    await dialog.getByRole("combobox").fill(text);
    await expect(dialog.getByTestId("activity-log-palette")).toBeVisible();
  }
  await dialog.getByTestId("activity-log-palette").click();
  await expect(page).toHaveURL(/\/sources\/logs$/);
});

test("list filters survive navigation in the URL and an unmatched date range has an empty state", async ({ page }) => {
  await page.goto("/sources/logs");
  await page.getByTestId("activity-log-filter-type").selectOption("system");
  await page.getByTestId("activity-log-filter-issues").check();
  await page.getByTestId("activity-log-filter-range").selectOption("30d");
  await page.getByTestId("activity-log-filter-apply").click();
  await expect(page).toHaveURL(/type=system/);
  await expect(page).toHaveURL(/issues=1/);
  await page.reload();
  await expect(page.getByTestId("activity-log-filter-type")).toHaveValue("system");
  await expect(page.getByTestId("activity-log-filter-issues")).toBeChecked();
  await expect(page.locator('[data-testid="activity-log-row"]:not([data-activity-log-scope="system"])')).toHaveCount(0);
  await page.goto("/sources/logs?type=cycle&status=partial&range=30d&issues=1");
  await expect(page.getByTestId("activity-log-row").first()).toBeVisible();
  await expect(page.getByTestId("activity-log-row").first()).toHaveAttribute("data-activity-log-scope", "cycle");
  await page.goto("/sources/logs?range=custom&from=2099-01-01&to=2099-01-02");
  await expect(page.getByTestId("activity-log-empty")).toBeVisible();
});

test("cycle deep link ignores date filters and shows queries, ledger, steps and job events", async ({ page }) => {
  await openCycle(page);
  await expect(page.getByTestId("activity-log-tree").locator('[data-activity-log-span-name^="step."]')).toHaveCount(7);
  const queries = page.getByTestId("activity-log-queries");
  const unknown = queries.locator('[data-testid="activity-log-query"][data-activity-log-has-run="false"]');
  await expect(unknown).toHaveCount(1);
  await expect(unknown).toContainText("未知");
  // Query, channel, status, reason, fetched, new, cost: the last three are unknown, never zero.
  for (const column of [4, 5, 6]) await expect(unknown.locator("td,th").nth(column)).toHaveText("未知");
  await expect(queries).toContainText("计费单位");
  await expect(queries).toContainText("当时未记录");
  await expect(queries).toContainText("多种原因");
  await expect(queries).toContainText("预算已用尽");
  await expect(queries).toContainText("熔断保护中");
  await expect(page.getByTestId("activity-log-not-reached")).toContainText("2");
  await expect(page.getByTestId("activity-log-events").getByTestId("activity-log-job").first()).toHaveAttribute("href", /^\/jobs\/\d+$/);
  await expect(page.getByTestId("activity-log-missing-job")).toHaveText("岗位已不存在");
  await expect(page.getByTestId("activity-log-events")).toContainText("原文无法解析");
  await expect(page.getByTestId("activity-log-ai-usage")).toHaveAttribute("href", /range=custom&from=\d{4}-\d{2}-\d{2}&to=/);
  await page.getByTestId("activity-log-level").selectOption("error");
  await page.getByTestId("activity-log-level-apply").click();
  await expect(page).toHaveURL(/level=error/);
  await expect(page.getByTestId("activity-log-event")).toHaveCount(2);
});

test("attempt history retains its own status and only the latest shows the current request status", async ({ page }) => {
  await waitForServerActions(page);
  const sql = connect();
  try {
    const [attempt] = await sql<{ id: string }[]>`select id from activity_spans where name='request.translate_job' and parent_id is null order by started_at limit 1`;
    if (!attempt) throw new Error("seed attempts missing");
    await page.goto(`/sources/logs/${attempt.id}`);
    await expect(page.getByTestId("activity-log-root-job")).toHaveAttribute("href", /^\/jobs\/\d+$/);
    const attempts = page.getByTestId("activity-log-attempt");
    await expect(attempts).toHaveCount(2);
    await expect(attempts.nth(0)).toContainText("已中断");
    await expect(attempts.nth(0)).not.toContainText("请求当前状态");
    await expect(attempts.nth(1)).toContainText("成功");
    await expect(attempts.nth(1)).toContainText("请求当前状态：已完成");
    await attempts.nth(1).getByRole("link").click();
    await expect(page.getByTestId("activity-log-attempts")).toBeVisible();
  } finally { await sql.end({ timeout: 5 }); }
});

test("English and Chinese translate status and step labels, with no mobile page overflow", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL! }]);
  await openCycle(page);
  await expect(page.getByTestId("activity-log-tree")).toContainText("Collect");
  await expect(page.getByTestId("activity-log-status").first()).toContainText("Partial");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "zh", url: baseURL! }]);
  await page.reload();
  await expect(page.getByTestId("activity-log-tree")).toContainText("采集");
  await expect(page.getByTestId("activity-log-status").first()).toContainText("部分完成");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/sources/logs");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

async function insertRoot(sql: ReturnType<typeof connect>, options: { active?: boolean; at?: string } = {}) {
  const id = randomUUID();
  await sql`insert into activity_spans (id,root_id,scope,name,process,status,started_at,finished_at,last_activity_at,progress_done,progress_total)
    values (${id},${id},'system','system.backup','cli',${options.active ? 'running' : 'ok'},${options.at ?? new Date().toISOString()},${options.active ? null : new Date().toISOString()},now(),2,9)`;
  const eventId = randomUUID();
  await sql`insert into activity_events (id,root_id,span_id,at,level,code,params) values (${eventId},${id},${id},now(),'info','item.ok','{}')`;
  return id;
}

// Exclusive cases are serial within this file. Clear-all is deliberately last; no other spec reads activity records.
test.describe("isolated activity mutations", { tag: "@exclusive" }, () => {
  test.describe.configure({ mode: "serial" });

  test("active system work is pinned and progress refreshes without a page reload", async ({ page }) => {
    const sql = connect();
    let root: string | undefined;
    let heartbeat: string | undefined;
    try {
      root = await insertRoot(sql, { active: true, at: new Date(Date.now() - 60_000).toISOString() });
      const [hb] = await sql<{ id: string }[]>`insert into runner_heartbeats(process,at) values ('cli',now()) returning id`;
      heartbeat = hb!.id;
      await page.goto("/sources/logs");
      await expect(page.getByTestId("activity-log-row").first()).toHaveAttribute("data-activity-log-root-id", root);
      const row = page.locator(`[data-activity-log-root-id="${root}"]`);
      await expect(row.getByTestId("activity-log-progress")).toContainText("2/9");
      await waitForServerActions(page);
      await sql`update activity_spans set progress_done=7,last_activity_at=now() where id=${root}`;
      await expect(row.getByTestId("activity-log-progress")).toContainText("7/9", { timeout: 20_000 });
    } finally {
      await waitForServerActions(page);
      if (root) await sql`delete from activity_spans where id=${root}`;
      if (heartbeat) await sql`delete from runner_heartbeats where id=${heartbeat}`;
      await sql.end({ timeout: 5 });
    }
  });

  test("sensitive business text never enters HTML, RSC or delete-preview responses", async ({ page }) => {
    const sql = connect();
    const samples = ["sk-test-SECRET123", "https://example.test/jobs?token=abc", "Traceback SECRET_BODY", "SECRET_PAYLOAD", "SECRET_JD"];
    const sensitive = samples.join(" ");
    const bodies: Promise<string>[] = [];
    // Collect bodies of finished requests only: a still-streaming response (for example an RSC refresh cut short by the
    // next navigation) never resolves body(), so each read is also bounded.
    page.on("requestfinished", (request) => {
      const body = request.response().then((response) => response?.body()).then((buffer) => buffer?.toString("utf8") ?? "").catch(() => "");
      bodies.push(Promise.race([body, new Promise<string>((resolve) => setTimeout(() => resolve(""), 2_000))]));
    });
    const rootId = randomUUID();
    const requestRoot = randomUUID();
    let cycleId: string | undefined;
    let runId: string | undefined;
    let requestId: string | undefined;
    let rawId: string | undefined;
    let companyId: string | undefined;
    let jobId: string | undefined;
    const fixture = `activity-log-privacy-${randomUUID().slice(0, 8)}`;
    const channel = fixture;
    try {
      await sql`insert into channels(id,family,kind) values (${channel},'fixture','fixture')`;
      const [company] = await sql<{ id: string }[]>`insert into companies(name,name_norm) values ('Activity Privacy Co',${fixture}) returning id`;
      companyId = company!.id;
      const [job] = await sql<{ id: string }[]>`insert into jobs(company_id,title,title_norm,description) values (${companyId},'Activity Privacy Job',${fixture},${sensitive}) returning id`;
      jobId = job!.id;
      const [cycle] = await sql<{ id: string }[]>`insert into cycles(kind,status,started_at,finished_at,summary_json) values ('manual','succeeded',now(),now(),${sql.json({ steps: [{ name: "collect", status: "ok", durationMs: 12, error: sensitive, reason: sensitive }] })}) returning id`;
      cycleId = cycle!.id;
      const [run] = await sql<{ id: string }[]>`insert into runs(cycle_id,channel_id,status,error,error_code) values (${cycleId},${channel},'failed',${sensitive},${sensitive}) returning id`;
      runId = run!.id;
      const [raw] = await sql<{ id: string }[]>`insert into raw_postings(channel_id,external_id,payload_json,parse_status,parse_error,run_id) values (${channel},${fixture},${sql.json({ payload: sensitive })},'parse_failed',${sensitive},${runId}) returning id`;
      rawId = raw!.id;
      const [request] = await sql<{ id: string }[]>`insert into control_requests(kind,status,payload,result,requested_at) values ('translate_job','done',${sql.json({ private: sensitive })},${sql.json({ error: sensitive, detail: sensitive })},now() - interval '1 year') returning id`;
      requestId = request!.id;
      await sql`insert into ai_usage(provider,task,model,job_id,tokens_in,tokens_out,cost_estimate) values ('fixture-api','score','fixture',${jobId},1,1,0)`;
      await sql`insert into run_deliveries(run_id,channel_id,ledger,delivered,billed_units,distinct_ids,counts_json) values (${runId},${channel},'collect',1,1,1,${sql.json({ dispositions: { stored: 1 }, flags: {}, mismatch: [sensitive] })})`;
      await sql`insert into delivery_items(run_id,ordinal,batch,channel_id,disposition,payload_hash,payload_bytes,payload_json,payload_text,raw_posting_id,received_at) values (${runId},1,1,${channel},'stored','fixture',10,${sql.json({ private: sensitive })},${sensitive},${rawId},now())`;
      await sql`insert into activity_spans(id,root_id,scope,name,process,status,started_at,finished_at,last_activity_at,cycle_id) values (${rootId},${rootId},'cycle','cycle','runner','ok',now(),now(),now(),${cycleId})`;
      await sql`insert into activity_spans(id,root_id,scope,name,process,status,started_at,finished_at,last_activity_at,control_request_id,reason_code) values (${requestRoot},${requestRoot},'request','request.translate_job','runner','ok',now(),now(),now(),${requestId},${sensitive})`;
      const child = randomUUID();
      await sql`insert into activity_spans(id,root_id,parent_id,scope,name,process,status,started_at,finished_at,last_activity_at,run_id,query_id,channel_id) values (${child},${rootId},${rootId},'cycle','collect.query','runner','failed',now(),now(),now(),${runId},'0123456789abcdef',${channel})`;
      await sql`insert into activity_events(id,root_id,span_id,at,level,code,job_id,raw_posting_id,params) values (${randomUUID()},${rootId},${child},now(),'error','parse_failed',${jobId},${rawId},${sql.json({ error_code: sensitive })})`;
      await page.goto("/sources/logs");
      bodies.push(page.content());
      await page.goto(`/sources/logs/${rootId}`);
      bodies.push(page.content());
      await page.getByTestId("activity-log-delete-root").click();
      const response = page.waitForResponse((response) => response.request().method() === "POST" && response.request().headers()["next-action"] !== undefined);
      await page.getByTestId("activity-log-delete-prepare").click();
      await response;
      await expect(page.getByTestId("activity-log-delete-confirm")).toBeVisible();
      await waitForServerActions(page);
      bodies.push(page.content());
      await page.goto(`/sources/logs/${requestRoot}`);
      bodies.push(page.content());
      const captured = (await Promise.all(bodies)).join("\n");
      for (const sample of samples) expect(captured).not.toContain(sample);
    } finally {
      // Clean up even when the page is already gone (a timed-out test must not leave rows for the next run).
      await waitForServerActions(page).catch(() => undefined);
      await sql`delete from activity_spans where id in (${rootId},${requestRoot})`;
      if (jobId) await sql`delete from ai_usage where job_id=${jobId}`;
      if (rawId) await sql`delete from raw_postings where id=${rawId}`;
      if (runId) await sql`delete from runs where id=${runId}`;
      if (cycleId) await sql`delete from cycles where id=${cycleId}`;
      if (requestId) await sql`delete from control_requests where id=${requestId}`;
      if (jobId) await sql`delete from jobs where id=${jobId}`;
      if (companyId) await sql`delete from companies where id=${companyId}`;
      await sql`delete from channels where id=${channel}`;
      await sql.end({ timeout: 5 });
    }
  });

  test("single-entry and date-range deletions preview counts and preserve business rows", async ({ page }) => {
    const sql = connect();
    const roots: string[] = [];
    try {
      const before = await businessCounts(sql);
      const root = await insertRoot(sql);
      roots.push(root);
      await page.goto(`/sources/logs/${root}`);
      await page.getByTestId("activity-log-delete-root").click();
      await page.getByTestId("activity-log-delete-prepare").click();
      await expect(page.getByTestId("activity-log-delete-preview")).toContainText("1 个根条目和 1 条事件");
      await expect(page.getByTestId("activity-log-delete-preview")).toContainText("跳过进行中：0");
      await page.getByTestId("activity-log-delete-confirm").click();
      await expect(page).toHaveURL(/\/sources\/logs$/);
      await waitForServerActions(page);
      const ranged = await insertRoot(sql, { at: "2001-01-01T12:00:00Z" });
      roots.push(ranged);
      await page.getByTestId("activity-log-delete-range").click();
      await page.getByTestId("activity-log-delete-from").fill("2001-01-01");
      await page.getByTestId("activity-log-delete-to").fill("2001-01-01");
      await page.getByTestId("activity-log-delete-prepare").click();
      await expect(page.getByTestId("activity-log-delete-preview")).toContainText("1 个根条目和 1 条事件");
      await page.getByTestId("activity-log-delete-confirm").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await waitForServerActions(page);
      expect(await sql`select id from activity_spans where id in (${root},${ranged})`).toHaveLength(0);
      expect(await businessCounts(sql)).toEqual(before);
    } finally {
      await waitForServerActions(page);
      if (roots.length) await sql`delete from activity_spans where id in ${sql(roots)}`;
      await sql.end({ timeout: 5 });
    }
  });

  test("clear all previews the whole scope, skips active work and leaves all business counts unchanged", async ({ page }) => {
    const sql = connect();
    const roots: string[] = [];
    let heartbeat: string | undefined;
    try {
      roots.push(await insertRoot(sql), await insertRoot(sql, { active: true }));
      const [hb] = await sql<{ id: string }[]>`insert into runner_heartbeats(process,at) values ('cli',now()) returning id`;
      heartbeat = hb!.id;
      const before = await businessCounts(sql);
      // Count the actual fixture set. Seed activity may be present, but no business row belongs to the deletion scope.
      const [{ roots: expectedRoots }] = await sql<{ roots: number }[]>`select count(*)::int as roots from activity_spans where parent_id is null and id=root_id and id<>${roots[1]!}`;
      const [{ events: expectedEvents }] = await sql<{ events: number }[]>`select count(*)::int as events from activity_events where root_id<>${roots[1]!}`;
      await page.goto("/sources/logs?type=cycle&range=custom&from=2000-01-01&to=2000-01-01");
      await page.getByTestId("activity-log-delete-all").click();
      await page.getByTestId("activity-log-delete-prepare").click();
      const preview = page.getByTestId("activity-log-delete-preview");
      await expect(preview).toContainText(`${expectedRoots} 个根条目和 ${expectedEvents} 条事件`);
      await expect(preview).toContainText("跳过进行中：1");
      await page.getByTestId("activity-log-delete-confirm").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await waitForServerActions(page);
      const remaining = await sql<{ id: string }[]>`select id from activity_spans where parent_id is null`;
      expect(remaining.map((row) => row.id)).toEqual([roots[1]]);
      expect(await businessCounts(sql)).toEqual(before);
    } finally {
      await waitForServerActions(page);
      if (roots.length) await sql`delete from activity_spans where id in ${sql(roots)}`;
      if (heartbeat) await sql`delete from runner_heartbeats where id=${heartbeat}`;
      await sql.end({ timeout: 5 });
    }
  });
});

async function businessCounts(sql: ReturnType<typeof connect>) {
  const [counts] = await sql`select
    (select count(*)::int from cycles) as cycles, (select count(*)::int from runs) as runs,
    (select count(*)::int from raw_postings) as raw_postings, (select count(*)::int from ai_usage) as ai_usage,
    (select count(*)::int from control_requests) as control_requests, (select count(*)::int from run_deliveries) as run_deliveries,
    (select count(*)::int from delivery_items) as delivery_items`;
  return counts;
}
