import type { MonthUsage } from "@/lib/db/repos/channels";

import { BudgetExceededError } from "./errors";
import type { Channel, ChannelBudget, ChannelRuntimeSettings } from "./types";

/** `YYYY-MM` of `date` in `timeZone`: the calendar month budgets are counted in. */
export function monthKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  if (year === undefined || month === undefined) throw new Error(`monthKey: cannot format date for ${timeZone}`);
  return `${year}-${month}`;
}

/** USD are tracked to micro-dollar precision (runs.cost has 6 decimals). */
const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;
/** Tolerance when comparing floating point money. */
const EPSILON = 1e-9;

export interface UsageStore {
  loadUsage(month: string): Promise<Map<string, MonthUsage>>;
  addUsage(channelId: string, month: string, delta: MonthUsage): Promise<void>;
}

export interface BudgetTrackerOptions {
  store: UsageStore;
  month: string;
  /** `paid_total_monthly_budget_usd`. */
  globalCapUsd: number;
  settingsFor(channelId: string): ChannelRuntimeSettings | undefined;
}

export interface AttemptBudget extends ChannelBudget {
  /** What this attempt consumed so far (becomes the run row's cost). */
  readonly attempt: { records: number; usd: number };
}

/**
 * Month-to-date usage of all channels, checked against each channel's `monthly_budget_usd` and the
 * global `paid_total_monthly_budget_usd`. One tracker lives for one cycle; the runner is the only
 * writer while it holds the cycle lock, so the in-memory view is authoritative and every check is
 * synchronous before the (awaited) persistence.
 */
export class BudgetTracker {
  private constructor(
    private readonly options: BudgetTrackerOptions,
    private readonly usage: Map<string, MonthUsage>,
  ) {}

  static async create(options: BudgetTrackerOptions): Promise<BudgetTracker> {
    return new BudgetTracker(options, await options.store.loadUsage(options.month));
  }

  get month(): string {
    return this.options.month;
  }

  private used(channelId: string): MonthUsage {
    return this.usage.get(channelId) ?? { records: 0, usd: 0 };
  }

  /** Total USD spent by all channels this month. */
  globalUsd(): number {
    let total = 0;
    for (const u of this.usage.values()) total += u.usd;
    return roundUsd(total);
  }

  private settings(channelId: string): ChannelRuntimeSettings {
    const settings = this.options.settingsFor(channelId);
    if (!settings) throw new Error(`BudgetTracker: no settings for channel ${channelId}`);
    return settings;
  }

  private usdLeft(channelId: string): { channel: number; global: number } {
    return {
      channel: roundUsd(this.settings(channelId).monthlyBudgetUsd - this.used(channelId).usd),
      global: roundUsd(this.options.globalCapUsd - this.globalUsd()),
    };
  }

  private freeLeft(channelId: string): number {
    return Math.max(0, this.settings(channelId).freeRecordsPerMonth - this.used(channelId).records);
  }

  /**
   * Can this channel take (at least) one more record? True while free records remain or while the
   * budget covers one billable record. Channels without `estimateCost` (or a zero price) are free and always can.
   */
  hasHeadroom(channel: Channel): boolean {
    if (this.freeLeft(channel.id) > 0) return true;
    const unitCost = channel.estimateCost?.(1) ?? 0;
    if (unitCost <= 0) return true;
    const left = this.usdLeft(channel.id);
    return Math.min(left.channel, left.global) + EPSILON >= unitCost;
  }

  /** A budget handle for one collect attempt of `channel`. */
  forChannel(channel: Channel): AttemptBudget {
    const attempt = { records: 0, usd: 0 };

    const price = (records: number, costUsd?: number): { usd: number; freeRecords: number; paidRecords: number } => {
      if (!Number.isInteger(records) || records < 0) throw new RangeError("records must be a non-negative integer");
      const freeRecords = Math.min(records, this.freeLeft(channel.id));
      const paidRecords = records - freeRecords;
      const usd = roundUsd(costUsd ?? (paidRecords > 0 ? (channel.estimateCost?.(paidRecords) ?? 0) : 0));
      if (usd < 0) throw new RangeError("costUsd must be >= 0");
      return { usd, freeRecords, paidRecords };
    };

    const exceeded = (usd: number): BudgetExceededError | null => {
      if (usd <= 0) return null;
      const left = this.usdLeft(channel.id);
      if (usd > left.channel + EPSILON) {
        return new BudgetExceededError(
          "channel",
          `${channel.id}: monthly budget exhausted (needs $${usd}, $${Math.max(0, left.channel)} left of $${this.settings(channel.id).monthlyBudgetUsd})`,
        );
      }
      if (usd > left.global + EPSILON) {
        return new BudgetExceededError(
          "global",
          `${channel.id}: paid total budget exhausted (needs $${usd}, $${Math.max(0, left.global)} left of $${this.options.globalCapUsd})`,
        );
      }
      return null;
    };

    return {
      attempt,
      snapshot: () => {
        const used = this.used(channel.id);
        const left = this.usdLeft(channel.id);
        return {
          month: this.options.month,
          records: used.records,
          usd: roundUsd(used.usd),
          freeRecordsLeft: this.freeLeft(channel.id),
          usdLeft: Math.max(0, Math.min(left.channel, left.global)),
        };
      },
      canAfford: (records, costUsd) => exceeded(price(records, costUsd).usd) === null,
      consume: async (records, consumeOptions) => {
        const priced = price(records, consumeOptions?.costUsd);
        const problem = consumeOptions?.allowOverspend ? null : exceeded(priced.usd);
        if (problem) throw problem;
        const used = this.used(channel.id);
        this.usage.set(channel.id, { records: used.records + records, usd: roundUsd(used.usd + priced.usd) });
        attempt.records += records;
        attempt.usd = roundUsd(attempt.usd + priced.usd);
        await this.options.store.addUsage(channel.id, this.options.month, { records, usd: priced.usd });
        return priced;
      },
    };
  }
}
