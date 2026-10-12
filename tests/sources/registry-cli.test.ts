// @vitest-environment node
import { describe, expect, it } from "vitest";

import { cliRows, displayWidth, hasFailingEnabled, reasonsText, registryText, removedRows, renderRegistryJson, renderRegistryText, sortCliRows, unknownRows } from "@/lib/sources/registry/cli";

const ZH = registryText("zh");
import { buildRegistryView } from "@/lib/sources/registry/view";

import { shippedChannels } from "../channels/helpers";
import { boardHealth, cardsFor, HOUR, NOW, state, windowStat } from "./registry-helpers";

const shipped = shippedChannels();
const config = { ...shipped, sources: { ...shipped.sources, xing: { ...shipped.sources.xing, enabled: true } } };
const view = buildRegistryView({
  now: NOW,
  config,
  cards: cardsFor({ channelsConfig: config, states: [state("xing", { circuitState: "open", circuitOpenUntil: new Date(NOW.getTime() + 20 * HOUR), consecutiveFailures: 3, lastErrorCode: "blocked" })] }),
  channelStats: new Map([["xing", windowStat({ runs: 3, failed: 3, lastRun: { startedAt: new Date(NOW.getTime() - 5 * HOUR), status: "failed", errorCode: "blocked", interrupted: false } })]]),
  boardHealth: [boardHealth("greenhouse", "gegensprech", { lastStatus: "error", lastErrorCode: "not_found", consecutiveFailures: 3 })],
  boardSeen: new Map(),
});
const report = (rows: ReturnType<typeof cliRows>) => ({ rows: sortCliRows(rows), windowDays: 7, timeZone: "UTC", fileLabel: "config/sources.yaml", total: view.total, counts: view.counts, mirror: { syncedAt: NOW.toISOString(), inSync: true } });

describe("sources:list report", () => {
  it("prints the header line, the failing rows first with their reasons, and the summary", () => {
    const text = renderRegistryText(report(cliRows(view, { type: null, statuses: [] }, "UTC", ZH)), ZH);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`来源清单 config/sources.yaml · ${view.total} 个来源 · 镜像已同步 2026-10-08 12:00`);
    expect(lines[1]).toMatch(/^状态\s+id\s+类型\s+启用/);
    expect(lines[2]).toMatch(/^异常\s+xing\s+通道\s+是\s+10-08 07:00 失败/);
    expect(lines[2]).toContain("最近一轮失败：被网站拦截 · 连续 3 次 · 熔断到 10-09 08:00");
    expect(text).toContain("board:greenhouse:gegensprech");
    expect(text).toContain("连续 3 次失败：board 不存在（404）");
    expect(lines.at(-1)).toMatch(/^汇总：正常 \d+ · 不稳 0 · 异常 2 · 停用 \d+ · 未配置 \d+ · 从未运行 \d+ · 待命 \d+$/);
  });

  it("filters by type and by status (several)", () => {
    expect(cliRows(view, { type: "ats_board", statuses: [] }, "UTC", ZH).every((r) => r.type === "ats_board")).toBe(true);
    expect(cliRows(view, { type: null, statuses: ["failing"] }, "UTC", ZH).map((r) => r.id).sort()).toEqual(["board:greenhouse:gegensprech", "xing"]);
    expect(cliRows(view, { type: "channel", statuses: ["failing", "off"] }, "UTC", ZH).every((r) => ["failing", "off"].includes(r.status))).toBe(true);
  });

  it("--strict exits non-zero only for an enabled failing source", () => {
    const rows = cliRows(view, { type: null, statuses: [] }, "UTC", ZH);
    expect(hasFailingEnabled(rows)).toBe(true);
    expect(hasFailingEnabled(rows.filter((r) => r.status !== "failing"))).toBe(false);
    expect(hasFailingEnabled(rows.map((r) => (r.status === "failing" ? { ...r, enabled: false } : r)))).toBe(false);
  });

  it("without a database it lists the file's entries with health unknown", () => {
    const rows = unknownRows([{ id: "indeed", type: "channel", group: "job_boards", name: "indeed", enabled: true }], ZH);
    const text = renderRegistryText({ rows, windowDays: 7, timeZone: "UTC", fileLabel: "config/sources.yaml", total: 1, counts: null, mirror: null }, ZH);
    expect(text).toContain("数据库不可用");
    expect(text).toMatch(/未知\s+indeed/);
    expect(text).toContain("汇总：数据库不可用，没有健康状态");
  });

  it("lists entries that left the file with --all", () => {
    const rows = removedRows([{ id: "board:greenhouse:lieferfix", type: "ats_board", name: "Lieferfix", removedAt: "2026-10-01T10:00:00Z" }], "UTC", ZH);
    expect(renderRegistryText({ ...report(rows) }, ZH)).toContain("已移除");
  });

  it("JSON has the same rows and no secrets, only variable names", () => {
    const json = JSON.parse(renderRegistryJson({ ...report(cliRows(view, { type: null, statuses: ["failing"] }, "UTC", ZH)), generatedAt: NOW.toISOString() })) as { entries: Array<{ id: string; status: string; reason: string | null }>; counts: Record<string, number> };
    expect(json.entries.map((e) => e.id)).toEqual(["xing", "board:greenhouse:gegensprech"]);
    expect(json.entries[0]).toMatchObject({ status: "failing" });
    expect(json.counts.failing).toBe(2);
    expect(reasonsText([{ key: "missingEnv", values: { names: "TAVILY_API_KEY" } }], "UTC", ZH)).toBe("缺 TAVILY_API_KEY");
  });

  it("JSON carries codes (status, result, reason keys), never the Chinese words of the table", () => {
    const out = renderRegistryJson({ ...report(cliRows(view, { type: null, statuses: ["failing"] }, "UTC", ZH)), generatedAt: NOW.toISOString() });
    const json = JSON.parse(out) as { entries: Array<{ id: string; lastRunResult: string | null; reasons: Array<{ key: string; values?: Record<string, unknown> }> }> };
    expect(json.entries[0]).toMatchObject({ id: "xing", lastRunResult: "failed" });
    expect(json.entries[0]?.reasons[0]).toEqual({ key: "lastRunFailed", values: { error: "blocked" } });
    expect(json.entries[1]).toMatchObject({ id: "board:greenhouse:gegensprech", reasons: [{ key: "boardFailing", values: { count: 3, error: "not_found" } }] });
    expect(JSON.stringify(json.entries)).not.toMatch(/[\u4e00-\u9fff]/);
    // the table stays in Chinese
    expect(renderRegistryText(report(cliRows(view, { type: null, statuses: ["failing"] }, "UTC", ZH)), ZH)).toContain("失败");
  });

  it("a last run whose query was cut short after some pages reads interrupted, not partial", () => {
    const interruptedView = buildRegistryView({
      now: NOW,
      config,
      cards: cardsFor({ channelsConfig: config, states: [] }),
      channelStats: new Map([["xing", windowStat({ runs: 2, failed: 1, lastRun: { startedAt: new Date(NOW.getTime() - 5 * HOUR), status: "partial", errorCode: "network", interrupted: true } })]]),
      boardHealth: [],
      boardSeen: new Map(),
    });
    const of = (text: ReturnType<typeof registryText>) => cliRows(interruptedView, { type: "channel", statuses: [] }, "UTC", text).find((r) => r.id === "xing");
    expect(of(ZH)).toMatchObject({ lastRunResult: "interrupted", lastRunLabel: "中途中断" });
    expect(of(registryText("en"))).toMatchObject({ lastRunResult: "interrupted", lastRunLabel: "interrupted" });
  });

  it("measures CJK characters as two columns", () => {
    expect(displayWidth("异常")).toBe(4);
    expect(displayWidth("xing")).toBe(4);
  });

  it("prints the table in English with --lang en / cli.locale en, the JSON unchanged", () => {
    const EN = registryText("en");
    const rows = cliRows(view, { type: null, statuses: ["failing"] }, "UTC", EN);
    const text = renderRegistryText({ ...report(rows), windowDays: 14 }, EN);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Source registry config/sources.yaml · ${view.total} sources · mirror synced 2026-10-08 12:00`);
    expect(lines[1]).toMatch(/^State\s+id\s+Type\s+On\s+Last run\s+Last success\s+14d fetched\/new\s+Reason$/);
    expect(lines[2]).toMatch(/^Failing\s+xing\s+channel\s+yes\s+10-08 07:00 failed/);
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    expect(renderRegistryJson({ ...report(rows), generatedAt: NOW.toISOString() })).toBe(renderRegistryJson({ ...report(cliRows(view, { type: null, statuses: ["failing"] }, "UTC", ZH)), generatedAt: NOW.toISOString() }));
  });
});
