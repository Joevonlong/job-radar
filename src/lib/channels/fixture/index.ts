import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { getAppRoot } from "@/lib/config";

import { ChannelError } from "../errors";
import type { ChannelRegistry } from "../registry";
import {
  type Channel,
  type ChannelErrorCode,
  type ChannelFamily,
  type ChannelKind,
  type ChannelRuntimeSettings,
  type NormalizedPostingDraft,
  type RawPostingInput,
  type SearchQuery,
} from "../types";

/**
 * The `fixture` channel: serves postings from `tests/fixtures/fixture-channel/*.json` and can be told
 * to fail, so the framework (cascade, circuit breaker, isolation, dedup) can be exercised without
 * network access. Registered only by tests and by `pnpm cycle:run --channel fixture --dry-run`.
 */

export const FIXTURE_CHANNEL_ID = "fixture";

const fixturePostingSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string(),
  city: z.string().nullable(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  remote: z.boolean(),
  description: z.string(),
  url: z.string().nullable(),
  posted_at: z.string().nullable(),
});
export type FixturePosting = z.infer<typeof fixturePostingSchema>;

const fixtureFileSchema = z.object({ postings: z.array(fixturePostingSchema) });

export interface FixtureFailure {
  /** `throw` raises a plain Error (to check that unclassified errors become `unknown`). */
  code: ChannelErrorCode | "throw";
  /** How many collect calls fail before it recovers. Default: all of them. */
  times?: number;
  retryable?: boolean;
}

export interface FixtureChannelOptions {
  id?: string;
  family?: ChannelFamily;
  kind?: ChannelKind;
  usesQueries?: boolean;
  /** Directory of fixture files. Default `<app>/tests/fixtures/fixture-channel`. */
  dir?: string;
  /** Only these file names from `dir`. Default: every `*.json`. */
  files?: readonly string[];
  /** Serve these postings instead of reading files. */
  postings?: readonly FixturePosting[];
  failure?: FixtureFailure;
  /** USD per billable record (also drives `estimateCost`). Default 0: a free channel. */
  costPerRecordUsd?: number;
}

export interface FixtureChannel extends Channel {
  /** Queries received by `collect`, in order. */
  readonly seen: SearchQuery[];
}

export function defaultFixtureDir(): string {
  return path.join(getAppRoot(), "tests", "fixtures", "fixture-channel");
}

async function loadPostings(options: FixtureChannelOptions): Promise<FixturePosting[]> {
  if (options.postings) return [...options.postings];
  const dir = options.dir ?? defaultFixtureDir();
  const names = options.files ?? (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const postings: FixturePosting[] = [];
  for (const name of names) {
    const parsed = fixtureFileSchema.parse(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
    postings.push(...parsed.postings);
  }
  return postings;
}

export function createFixtureChannel(options: FixtureChannelOptions = {}): FixtureChannel {
  const seen: SearchQuery[] = [];
  let failuresLeft = options.failure?.times ?? Number.POSITIVE_INFINITY;
  const cost = options.costPerRecordUsd ?? 0;

  const channel: FixtureChannel = {
    id: options.id ?? FIXTURE_CHANNEL_ID,
    family: options.family ?? "manual",
    kind: options.kind ?? "manual",
    usesQueries: options.usesQueries ?? true,
    seen,
    ...(cost > 0 ? { estimateCost: (paidRecords: number) => paidRecords * cost } : {}),

    async collect(query, ctx): Promise<RawPostingInput[]> {
      seen.push(query);
      const failure = options.failure;
      if (failure && failuresLeft > 0) {
        failuresLeft -= 1;
        if (failure.code === "throw") throw new Error("fixture channel: unexpected failure");
        throw new ChannelError(failure.code, `fixture channel: simulated ${failure.code}`, {
          ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        });
      }
      const postings = (await loadPostings(options)).slice(0, query.maxResults);
      await ctx.budget.consume(postings.length);
      return postings.map((p) => ({
        externalId: p.id,
        url: p.url,
        payload: p,
        postedAt: p.posted_at === null ? null : new Date(p.posted_at),
      }));
    },

    parse(payload): NormalizedPostingDraft {
      const parsed = fixturePostingSchema.safeParse(payload);
      if (!parsed.success) throw new ChannelError("parse", "fixture channel: payload does not match the fixture posting shape");
      const p = parsed.data;
      return {
        title: p.title,
        companyName: p.company,
        locations: p.city === null ? [] : [{ label: p.city, city: p.city, countryCode: p.country }],
        workplace: p.remote ? "remote" : "unknown",
        description: p.description,
        postedAt: p.posted_at === null ? null : new Date(p.posted_at),
        applyUrl: p.url,
        sourceUrl: p.url,
      };
    },
  };
  return channel;
}

export const FIXTURE_SETTINGS: ChannelRuntimeSettings = {
  enabled: true,
  maxResults: 100,
  monthlyBudgetUsd: 0,
  freeRecordsPerMonth: 0,
  throttle: { minDelayMs: 0, maxDelayMs: 0 },
  extra: {},
};

/** Register a fixture channel with its own settings (it has no block in sources.yaml). */
export function registerFixtureChannel(
  registry: ChannelRegistry,
  options: FixtureChannelOptions & { settings?: Partial<ChannelRuntimeSettings> } = {},
): FixtureChannel {
  const { settings, ...channelOptions } = options;
  const channel = createFixtureChannel(channelOptions);
  registry.register(channel, { settings: { ...FIXTURE_SETTINGS, ...settings } });
  return channel;
}
