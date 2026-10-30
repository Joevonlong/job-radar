import { activityRow, activityEvent } from "./activity-helpers";
import { writeActivityBatch } from "@/lib/db/repos/activity";
import type { Db } from "@/lib/db/client";
import { aiUsage, channels, companies, controlRequests, cycles, deliveryItems, jobs, rawPostings, runDeliveries, runs } from "@/lib/db/schema";

export const PRIVATE_SAMPLES = ["sk-test-SECRET123", "https://example.test/jobs?token=abc", "Traceback SECRET_BODY", "SECRET_PAYLOAD", "SECRET_JD"];
const sensitive = PRIVATE_SAMPLES.join(" ");
export const READ_AT = new Date("2026-10-20T12:00:00Z");

/** Nonempty business fixtures make read privacy and deletion isolation assertions meaningful. */
export async function seedActivityReadFixture(db: Db) {
  await db.insert(channels).values({ id: "fixture", family: "fixture", kind: "fixture" });
  const [company] = await db.insert(companies).values({ name: "Example", nameNorm: "example" }).returning();
  const [job] = await db.insert(jobs).values({ companyId: company.id, title: "Engineer", titleNorm: "engineer", description: sensitive }).returning();
  const [cycle] = await db.insert(cycles).values({ kind: "manual", status: "succeeded", startedAt: READ_AT, finishedAt: READ_AT,
    summaryJson: { steps: [{ name: "collect", status: "ok", durationMs: 12, error: sensitive, reason: sensitive }] },
  }).returning();
  const [ai] = await db.insert(controlRequests).values({ kind: "run_ai", status: "pending", requestedAt: READ_AT,
    payload: { cycleId: cycle.id, private: sensitive }, result: { error: sensitive, detail: sensitive },
  }).returning();
  const [request] = await db.insert(controlRequests).values({ kind: "translate_job", status: "done", payload: { private: sensitive }, result: { error: sensitive, detail: sensitive } }).returning();
  const [run] = await db.insert(runs).values({ cycleId: cycle.id, channelId: "fixture", status: "partial", fetched: 7, newCount: 3, cost: 0.125, error: sensitive, errorCode: sensitive }).returning();
  const [runWithoutDelivery] = await db.insert(runs).values({ cycleId: cycle.id, channelId: "fixture", status: "succeeded", fetched: 2 }).returning();
  const [raw] = await db.insert(rawPostings).values({ channelId: "fixture", externalId: "private", payloadJson: { private: sensitive }, parseError: sensitive, runId: run.id }).returning();
  await db.insert(runDeliveries).values({ runId: run.id, channelId: "fixture", ledger: "collect", delivered: 7, billedUnits: 9, distinctIds: 6,
    countsJson: { dispositions: { stored: 3, outside_window: 2, no_identity: 2 }, flags: {}, mismatch: [sensitive] },
  });
  await db.insert(deliveryItems).values({ runId: run.id, ordinal: 1, batch: 1, channelId: "fixture", disposition: "stored", payloadHash: "hash", payloadBytes: 10,
    externalId: sensitive, payloadJson: { private: sensitive }, payloadText: sensitive, rawPostingId: raw.id, receivedAt: READ_AT,
  });
  await db.insert(aiUsage).values({ provider: "fixture-api", task: "score", model: "fixture-model", tokensIn: 20, tokensOut: 10, costEstimate: 0.1, equivalentCostUsd: 0.2, at: READ_AT, jobId: job.id });
  const root = activityRow({ scope: "cycle", name: "cycle", status: "ok", cycleId: cycle.id, startedAt: READ_AT, finishedAt: READ_AT, lastActivityAt: READ_AT, progressDone: 3, progressTotal: 3, eventsDropped: 1 });
  const step = activityRow({ rootId: root.id, parentId: root.id, scope: "cycle", name: "step.collect", status: "ok", startedAt: READ_AT, finishedAt: READ_AT, eventsDropped: 2 });
  const queries = [0, 1, 2].map((index) => activityRow({ rootId: root.id, parentId: step.id, scope: "cycle", name: "collect.query", status: "skipped", reasonCode: "mixed", channelId: "fixture", queryId: `query-${index}`,
    startedAt: new Date(READ_AT.getTime() + index), runId: index === 0 ? run.id : null, finishedAt: READ_AT,
  }));
  const attempt1 = activityRow({ scope: "request", name: "request.translate_job", status: "interrupted", controlRequestId: request.id, startedAt: READ_AT, finishedAt: READ_AT });
  const attempt2 = activityRow({ scope: "request", name: "request.translate_job", status: "ok", controlRequestId: request.id, startedAt: new Date(READ_AT.getTime() + 1), finishedAt: READ_AT });
  const events = [activityEvent(queries[0], { code: "cascade_reasons", params: { fixture: "budget_exceeded", second: "circuit_open" } }),
    activityEvent(step, { code: "queries_not_reached", params: { count: 2 } }), activityEvent(root, { code: "queries_not_reached", params: { count: 3 } }),
    activityEvent(queries[0], { level: "warn", code: "item.failed", jobId: job.id, rawPostingId: raw.id, params: { error_code: "network" } }),
    activityEvent(root, { level: "error", code: "parse_failed", jobId: 999999, rawPostingId: raw.id }),
  ];
  await writeActivityBatch(db, { roots: [root, attempt1, attempt2], spans: [root, step, ...queries, attempt1, attempt2], events, batchSize: 10 });
  return { root, step, queries, attempt1, attempt2, cycle, request, ai, run, runWithoutDelivery, job, raw };
}
