import { assertCredentialEndpoint } from "../../credential-endpoint";
import { ChannelError, InfrastructureError } from "../../errors";
import { abortReason, createHttpClient, defaultSleep, readTextUpTo, type FetchLike, type SleepFn } from "../../http";
import type { ChannelContext, HttpClient, HttpResponse } from "../../types";
import {
  acceptedRunSchema, billedUnitsSchema, calculateRunCost, errorForResponse, errorResponseSchema, isTerminal, MAX_RESPONSE_CHARS,
  outputSchema, priceSchema, providerResponseSchema, runCostSchema, runResponseSchema, stopAcceptedSchema,
  validateFinalInput, type MonidCostObservation, type MonidRun, type MonidSettings, type RunCost,
} from "./contract";

/** POSTs are never retried; GETs leave ordinary 5xx to the HTTP layer's backoff. */
const ALLOW_POST_STATUS = Array.from({ length: 200 }, (_, index) => index + 400);
const ALLOW_POLL_STATUS = [400, 401, 402, 403, 404, 408, 409, 429, 502, 503];
const NOT_EXECUTED_STATUS = [400, 401, 402, 403, 404, 409, 429, 503];
const isTransientPollStatus = (status: number | undefined): boolean => status === 408 || status === 429 || (status !== undefined && status >= 500);
type ObserveRun = (body: unknown) => void;

export interface MonidClientOptions {
  ctx: ChannelContext;
  apiKey: string;
  settings: MonidSettings;
  environment?: Readonly<Record<string, string | undefined>>;
  sleep?: SleepFn;
  now?: () => number;
  /** Independent cancellation cleanup transport; production uses native fetch, without the cycle signal. */
  stopFetch?: FetchLike;
}

/** One billable POST, then polling. Accounting also covers requests whose outcome cannot be recovered. */
export class MonidClient {
  private readonly sleep: SleepFn;
  private readonly now: () => number;

  constructor(private readonly options: MonidClientOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json", "Content-Type": "application/json" };
  }

  private url(path: string): string {
    return new URL(path, this.options.settings.api_base_url).toString();
  }

  private runPath(runId: string): string {
    // Do not let a credential echoed in an untrusted response reach a URL or the HTTP retry logger.
    if (runId.includes(this.options.apiKey)) throw new ChannelError("parse", "Monid returned an unsafe run id");
    return `/v1/runs/${encodeURIComponent(runId)}`;
  }

  private async body(response: HttpResponse): Promise<unknown> {
    const read = response.textUpTo ? await response.textUpTo(MAX_RESPONSE_CHARS) : await readTextUpTo(response, MAX_RESPONSE_CHARS);
    if (read.truncated || read.text.length > MAX_RESPONSE_CHARS) throw new ChannelError("parse", "Monid response exceeds the size limit");
    try {
      return JSON.parse(read.text) as unknown;
    } catch {
      // A JSON syntax error can include a fragment of the body; never retain it as a cause.
      throw new ChannelError("parse", "Monid response is not valid JSON");
    }
  }

  private async stop(runId: string, independent: boolean, observe: ObserveRun): Promise<{ conflict: boolean; run: MonidRun | null }> {
    const { ctx, settings, stopFetch } = this.options;
    // Both limits are configurable. With the default settings this cleanup has its own five-second timeout.
    const timeoutMs = Math.min(settings.poll_interval_ms, settings.stop_grace_ms);
    const http: HttpClient = independent ? createHttpClient({
      settings: { timeoutMs, maxRetries: 0, backoffBaseMs: 0, backoffMaxMs: 0 },
      ...(stopFetch ? { fetch: stopFetch } : {}),
    }) : ctx.http;
    const response = await http.request(this.url(`${this.runPath(runId)}/stop`), {
      method: "POST", headers: this.headers(), maxRetries: 0, timeoutMs, redirect: "error", allowStatus: ALLOW_POST_STATUS,
    });
    let body: unknown;
    try {
      body = await this.body(response);
    } catch (error) {
      if (response.status !== 409 || (!independent && ctx.signal.aborted)) throw error;
      return { conflict: true, run: null };
    }
    observe(body);
    const run = runResponseSchema.safeParse(body);
    if (run.success && isTerminal(run.data.status)) return { conflict: response.status === 409, run: run.data };
    if (response.status === 409) return { conflict: true, run: null };
    const failure = errorForResponse(response.status, body);
    if (failure) throw failure;
    if (response.status !== 202 || !stopAcceptedSchema.safeParse(body).success) throw new ChannelError("parse", "Monid stop response has an unexpected shape");
    return { conflict: false, run: null };
  }

  private async poll(runId: string, deadline: number, observe: ObserveRun, immediate = false): Promise<MonidRun | null> {
    const { ctx, settings } = this.options;
    for (;;) {
      ctx.signal.throwIfAborted();
      if (!immediate) await this.sleep(Math.min(settings.poll_interval_ms, Math.max(0, deadline - this.now())), ctx.signal);
      immediate = false;
      const remaining = deadline - this.now();
      if (remaining <= 0) return null;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, remaining);
      });
      let result: { status: number; body: unknown } | null;
      let httpStatus: number | undefined;
      try {
        // Bound the complete GET (including its body and HTTP backoff), rather than each retry independently.
        result = await Promise.race([
          (async () => {
            const response = await ctx.http.request(this.url(this.runPath(runId)), {
              headers: this.headers(), allowStatus: ALLOW_POLL_STATUS, redirect: "error", timeoutMs: remaining, signal: controller.signal,
            });
            httpStatus = response.status;
            return { status: response.status, body: await this.body(response) };
          })(),
          expired,
        ]);
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (this.now() >= deadline) return null;
        if (httpStatus !== undefined && httpStatus >= 400 && !isTransientPollStatus(httpStatus)) {
          throw errorForResponse(httpStatus, {}) ?? error;
        }
        if (isTransientPollStatus(httpStatus) || (error instanceof ChannelError &&
          (error.code === "network" || error.code === "rate_limited" || isTransientPollStatus(error.status)))) continue;
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (result === null) return null;
      observe(result.body);
      const parsed = runResponseSchema.safeParse(result.body);
      if (parsed.success && isTerminal(parsed.data.status)) return { ...parsed.data, runId };
      if (parsed.success || isTransientPollStatus(result.status)) continue;
      const failure = errorForResponse(result.status, result.body);
      if (failure) throw failure;
      if (!parsed.success) throw new ChannelError("parse", "Monid polling response has no valid status");
    }
  }

  async run(input: Record<string, unknown>, limit: number): Promise<unknown[]> {
    const { ctx, settings, apiKey } = this.options;
    validateFinalInput(input, limit);
    assertCredentialEndpoint("monid", settings.api_base_url, ctx, this.options.environment ?? process.env);
    ctx.signal.throwIfAborted();
    const startedAt = this.now();
    let runId: string | undefined;
    let accounted = false;
    let rejected = false;
    let stopRequested = false;
    let observedCost: RunCost | null = null;
    let observedUnits: number | undefined;
    let observedCount: number | undefined;
    const invalidFields = new Set<string>();
    const fields = (): Record<string, unknown> => runId === undefined ? {} : { runId: runId.replaceAll(apiKey, "[redacted]") };
    const observe: ObserveRun = (body) => {
      const parsed = runCostSchema.safeParse(body);
      if (!parsed.success) return;
      const cost = calculateRunCost(parsed.data, limit, settings);
      for (const field of cost.invalidFields) invalidFields.add(field);
      const units = billedUnitsSchema.safeParse(parsed.data.billedUnits);
      if (units.success) observedUnits = units.data;
      if (Array.isArray(parsed.data.output)) observedCount = parsed.data.output.length;
      // Settlements accumulate across responses; calculated amounts only track the latest usable fallback.
      if ((cost.source === "settled" && (observedCost?.source !== "settled" || cost.costUsd > observedCost.costUsd)) ||
        (cost.source === "calculated" && observedCost?.source !== "settled")) observedCost = cost;
    };

    const record = async (run: MonidCostObservation): Promise<void> => {
      observe(run);
      const cost = observedCost ?? calculateRunCost(run, limit, settings);
      const units = observedUnits ?? observedCount ?? cost.units;
      // A failed usage write must not trigger a second attempt to consume the same bill.
      accounted = true;
      try {
        await ctx.budget.consume(units, { costUsd: cost.costUsd, allowOverspend: true });
      } catch (error) {
        throw new InfrastructureError("could not record Monid usage", error);
      }
      if (invalidFields.size > 0) ctx.logger.warn("monid cost fields could not be parsed", { ...fields(), fields: [...invalidFields] });
      if (cost.source === "calculated") ctx.logger.warn("monid using calculated cost without settled fields", fields());
      if (cost.conservative) ctx.logger.warn("monid run outcome uncertain; charged the configured limit", { ...fields(), limit });
      ctx.logger.info("monid run usage recorded", { ...fields(), units, usd: cost.costUsd });
    };
    const finish = async (run: MonidRun, httpStatus = 200): Promise<unknown[]> => {
      runId = run.runId ?? runId;
      await record(run);
      ctx.signal.throwIfAborted();
      const failure = errorForResponse(httpStatus, run);
      if (failure) throw failure;
      const provider = providerResponseSchema.safeParse(run.providerResponse);
      if (provider.success && provider.data.httpStatus === 404) return [];
      const output = outputSchema.safeParse(run.output);
      if (!output.success) throw new ChannelError("parse", "Monid output is not an array of harvestapi items");
      return output.data;
    };

    try {
      const response = await ctx.http.request(this.url("/v1/run"), {
        method: "POST", headers: this.headers(), body: JSON.stringify({ provider: settings.provider, endpoint: settings.endpoint, input: { body: input } }),
        maxRetries: 0, timeoutMs: settings.timeout_ms, allowStatus: ALLOW_POST_STATUS, redirect: "error",
      });
      const body = await this.body(response);
      observe(body);
      // An unreadable/truncated response cannot prove that the paid request was refused.
      rejected = NOT_EXECUTED_STATUS.includes(response.status);
      const terminal = runResponseSchema.safeParse(body);
      if (terminal.success && isTerminal(terminal.data.status)) return await finish(terminal.data, response.status);
      const failure = errorForResponse(response.status, body);
      if (failure) {
        // Validate errors as well, but never include their text or validation values in logs or exceptions.
        if (!errorResponseSchema.safeParse(body).success) ctx.logger.warn("monid error response has an unexpected shape");
        throw failure;
      }
      const accepted = acceptedRunSchema.safeParse(body);
      if (!accepted.success) throw new ChannelError("parse", "Monid run response has no valid run id");
      runId = accepted.data.runId;
      this.runPath(runId);
      const price = priceSchema.safeParse(accepted.data.price);
      if (price.success && price.data.type === "PER_RESULT" &&
        (price.data.amount.value > settings.price_per_1k_usd / 1000 || (price.data.flatFee?.value ?? 0) > settings.flat_fee_usd)) {
        ctx.logger.warn("monid advertised price exceeds configured price", { ...fields(), amount: price.data.amount.value, flatFee: price.data.flatFee?.value });
      }
      const run = await this.poll(runId, startedAt + settings.timeout_ms, observe);
      if (run) return await finish(run);
      let final: MonidRun | null;
      let pollingGrace = false;
      try {
        stopRequested = true;
        const stopped = await this.stop(runId, false, observe);
        // A 409 always needs a fresh GET: the run may have completed, or may still be un-stoppable.
        if (stopped.run && !stopped.conflict) final = { ...stopped.run, runId };
        else {
          pollingGrace = true;
          final = await this.poll(runId, this.now() + settings.stop_grace_ms, observe, stopped.conflict);
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        if (pollingGrace && error instanceof ChannelError && error.status === 404) throw error;
        throw new ChannelError("network", "Monid stop or grace polling failed before settlement", { retryable: true });
      }
      if (final) return await finish(final);
      throw new ChannelError("network", "Monid run did not reach a terminal state within the stop grace period", { retryable: true });
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      if (ctx.signal.aborted) {
        if (!accounted) {
          let final: MonidRun | null = null;
          if (runId !== undefined) {
            try {
              final = (await this.stop(runId, true, observe)).run;
            } catch {
              ctx.logger.warn("monid cancellation stop failed", fields());
            }
          }
          const cost = final ? calculateRunCost(final, limit, settings) : null;
          await record(final && cost && cost.source !== "estimate" ? final : { status: "TIMED_OUT" });
        }
        throw abortReason(ctx.signal);
      }
      if (!accounted && runId !== undefined && !stopRequested && error instanceof ChannelError && !error.retryable) {
        stopRequested = true;
        try {
          await this.stop(runId, true, observe);
        } catch {
          ctx.logger.warn("monid failure stop failed", fields());
        }
      }
      if (!accounted && (!rejected || runId !== undefined || observedCost !== null)) await record({ status: "TIMED_OUT" });
      if (ctx.signal.aborted) throw abortReason(ctx.signal);
      // The HTTP layer's cause may contain transport details or echoed credentials. Keep only classification.
      if (error instanceof ChannelError) throw new ChannelError(error.code, error.message.replaceAll(apiKey, "[redacted]"), {
        retryable: error.retryable, status: error.status, retryAfterMs: error.retryAfterMs, tripsCircuit: error.tripsCircuit,
      });
      throw new ChannelError("network", "Monid request failed before its outcome could be recovered", { retryable: true });
    }
  }
}
