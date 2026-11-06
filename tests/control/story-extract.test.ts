// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { writerSchema } from "@/lib/config/schemas/writer";
import { createStoryExtractHandler } from "@/lib/control/story-extract";
import { requestStoryExtract } from "@/lib/control/story-extract-request";
import type { Db } from "@/lib/db/client";
import type { ControlRequest } from "@/lib/db/repos/control-requests";
import { findLatestStoryExtractRequest, insertControlRequest } from "@/lib/db/repos/control-requests";
import { quietLogger } from "../cycle/helpers";

vi.mock("@/lib/control/expire", () => ({ expireScrubbedRequests: vi.fn() }));
vi.mock("@/lib/db/repos/control-requests", () => ({ findLatestStoryExtractRequest: vi.fn(), insertControlRequest: vi.fn() }));
const db = {} as Db;
const writer = writerSchema.parse({ enabled: true, import: { min_chars: 5, max_chars: 1000 } });
const row = (payload: unknown): ControlRequest => ({ id: 1, kind: "story_extract", status: "running", payload, result: null, requestedAt: new Date(), startedAt: new Date(), finishedAt: null });
const payload = (text: string) => ({ origin: "resume", text, sourceHash: createHash("sha256").update(text).digest("hex"), sourceChars: text.length, truncated: false });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(findLatestStoryExtractRequest).mockResolvedValue(null); vi.mocked(insertControlRequest).mockResolvedValue(row({})); });

it.each([["abc", "no_text"], ["x".repeat(1001), "too_long"], ["Email: private@example.invalid", "review_again"]])("refuses unconfirmed text with %s", async (text, error) => {
  const result = await requestStoryExtract(db, { origin: "resume", text, writer });
  expect(result).toMatchObject({ state: "error", error });
  if (error === "review_again") expect(result).toMatchObject({ text: "Email: [email]", highlights: [] });
  expect(findLatestStoryExtractRequest).not.toHaveBeenCalled();
  expect(insertControlRequest).not.toHaveBeenCalled();
});

it("queues the complete confirmed text without trimming or truncation", async () => {
  const text = `  ${"x".repeat(990)}\n`;
  expect(await requestStoryExtract(db, { origin: "resume", text, writer })).toMatchObject({ state: "queued", truncated: false });
  expect(insertControlRequest).toHaveBeenCalledWith(db, { kind: "story_extract", payload: { ...payload(text), confirmed: true } });
});

it.each([[false, "Built a service", "preview_required"], [true, "Email private@example.invalid", "scrub_mismatch"]] as const)("rejects unsafe queue payloads before creating a router (%s)", async (confirmed, text, code) => {
  const createRouter = vi.fn();
  const handler = createStoryExtractHandler({ loadSettings: () => writer, createRouter });
  const result = await handler(row({ ...payload(text), ...(confirmed ? { confirmed: true } : {}) }), { db, logger: quietLogger, signal: new AbortController().signal });
  expect(result).toMatchObject({ status: "failed", result: { error: code } });
  expect(createRouter).not.toHaveBeenCalled();
});
