import { BudgetExceededError, ChannelError } from "../../errors";
import { defaultSleep, type SleepFn } from "../../http";
import type { ChannelContext, HttpResponse } from "../../types";
import {
  MAX_RESPONSE_CHARS,
  BRIGHTDATA_API_ORIGIN,
  progressResponseSchema,
  progressUrl,
  snapshotUrl,
  triggerResponseSchema,
  triggerUrl,
  type DiscoveryInput,
} from "./contract";

/** HTTP statuses the client handles itself instead of letting `ctx.http` raise. */
const PAYMENT_REQUIRED = 402;
/** Snapshot download answers 202 / 409 while the snapshot is still being built. */
const NOT_READY_STATUSES = [202, 409] as const;

export interface BrightDataClientOptions {
  ctx: ChannelContext;
  apiKey: string;
  datasetId: string;
  pollIntervalMs: number;
  /** Trigger to download (snapshot build + download): give up after this long. */
  timeoutMs: number;
  sleep?: SleepFn;
  /** Milliseconds clock; tests advance it from their fake `sleep`. */
  now?: () => number;
  origin?: string;
}

export interface Snapshot {
  snapshotId: string;
  /** Items exactly as delivered (job records and provider error records). */
  items: unknown[];
  ordinals: (number | undefined)[];
}

/** Parse a snapshot body: a JSON array, or (when the provider ignores `format=json`) NDJSON. */
export function parseSnapshotBody(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) return [parsed];
  } catch {
    // fall through to NDJSON
  }
  try {
    return trimmed
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line): unknown => JSON.parse(line));
  } catch (error) {
    throw new ChannelError("parse", "Bright Data snapshot is neither a JSON array nor NDJSON", { cause: error });
  }
}

/**
 * The asynchronous trigger -> progress -> snapshot flow. All requests go through `ctx.http`
 * (timeouts, retries, classified errors). The Authorization header is only ever set here and
 * never logged. The trigger is sent once (no retries): repeating it could bill twice.
 */
export class BrightDataClient {
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly origin: string;

  constructor(private readonly options: BrightDataClientOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.origin = options.origin ?? BRIGHTDATA_API_ORIGIN;
  }

  private headers(withBody: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: "application/json",
      ...(withBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  private paymentRequired(): BudgetExceededError {
    return new BudgetExceededError("channel", "Bright Data answered 402: the provider account needs billing or credits");
  }

  private async get(url: string, allowStatus: readonly number[]): Promise<HttpResponse> {
    const response = await this.options.ctx.http.request(url, {
      headers: this.headers(false),
      allowStatus: [PAYMENT_REQUIRED, ...allowStatus],
    });
    if (response.status === PAYMENT_REQUIRED) throw this.paymentRequired();
    return response;
  }

  async trigger(inputs: readonly DiscoveryInput[], limitPerInput: number): Promise<string> {
    const { ctx, datasetId } = this.options;
    const response = await ctx.http.request(triggerUrl(datasetId, limitPerInput, this.origin), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(inputs),
      maxRetries: 0,
      allowStatus: [PAYMENT_REQUIRED],
    });
    if (response.status === PAYMENT_REQUIRED) throw this.paymentRequired();
    const parsed = triggerResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ChannelError("parse", "Bright Data trigger response has no valid snapshot_id");
    return parsed.data.snapshot_id;
  }

  /** Status of the snapshot: true when ready, false while it is still being built. Throws when it failed. */
  private async isReady(snapshotId: string): Promise<boolean> {
    const response = await this.get(progressUrl(snapshotId, this.origin), []);
    const parsed = progressResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ChannelError("parse", "Bright Data progress response has no status");
    const status = parsed.data.status.toLowerCase();
    if (status === "ready") return true;
    if (status === "failed" || status === "canceled" || status === "cancelled") {
      throw new ChannelError("unknown", `Bright Data snapshot ${status}`, { retryable: false });
    }
    return false;
  }

  private async download(snapshotId: string, batch: number): Promise<Pick<Snapshot, "items" | "ordinals"> | null> {
    const response = await this.get(snapshotUrl(snapshotId, this.origin), NOT_READY_STATUSES);
    if ((NOT_READY_STATUSES as readonly number[]).includes(response.status)) return null;
    const text = await response.text();
    const { deliveries } = this.options.ctx;
    const unparsed = () => {
      for (const ordinal of deliveries.received({ batch, text })) deliveries.drop(ordinal, "unparsed_response");
    };
    if (text.length > MAX_RESPONSE_CHARS) {
      unparsed();
      throw new ChannelError("parse", "Bright Data snapshot exceeds the size limit");
    }
    let items: unknown[];
    try {
      items = parseSnapshotBody(text);
    } catch (error) {
      unparsed();
      throw error;
    }
    const ordinals = deliveries.received({ batch, items });
    return { items, ordinals: items.map((_, index) => ordinals[index]) };
  }

  /** Trigger, wait until ready (or time out), download. */
  async run(inputs: readonly DiscoveryInput[], limitPerInput: number): Promise<Snapshot> {
    const { ctx, pollIntervalMs, timeoutMs } = this.options;
    const batch = ctx.deliveries.beginBatch();
    const startedAt = this.now();
    const snapshotId = await this.trigger(inputs, limitPerInput);
    ctx.logger.info("bright data snapshot triggered", { inputs: inputs.length, limitPerInput });

    for (;;) {
      if (await this.isReady(snapshotId)) {
        const snapshot = await this.download(snapshotId, batch);
        if (snapshot !== null) return { snapshotId, ...snapshot };
      }
      if (this.now() - startedAt + pollIntervalMs > timeoutMs) {
        // the snapshot keeps building at the provider (results are kept for 30 days): log its id so it can be fetched later
        ctx.logger.warn("bright data snapshot timed out", { snapshotId, timeoutMs });
        throw new ChannelError("network", `Bright Data snapshot ${snapshotId} not ready within ${timeoutMs} ms (retrievable later by id)`, { retryable: true });
      }
      ctx.signal.throwIfAborted();
      await this.sleep(pollIntervalMs, ctx.signal);
    }
  }
}
