/**
 * `pnpm agent:token create|list|revoke`: the agent tokens of MCP connections that are not the local stdio process. `create` prints
 * the token alone on standard output, once; everything else goes to standard error. Nothing prints a token's hash, and the token
 * cannot be shown again: the database has only its hash.
 */
import { parseArgs } from "node:util";

import { z } from "zod";

import type { Executor } from "@/lib/db/executor";
import { findUnrevokedAgentTokens, insertAgentToken, listAgentTokens, revokeAgentToken, type AgentTokenSummary } from "@/lib/db/repos/agent-tokens";
import type { translatorFor } from "@/lib/i18n/node";

import { isPermission, PERMISSION_PRESETS, PERMISSIONS, type Permission } from "./permissions";
import { agentTokenState, generateAgentToken, storedPermissions } from "./tokens";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const NAME_MAX = 64;
const PRESET_NAMES = Object.keys(PERMISSION_PRESETS) as (keyof typeof PERMISSION_PRESETS)[];

export interface AgentTokenCliInput {
  db: Executor;
  argv: readonly string[];
  now: () => Date;
  /** schedule.yaml `timezone`: the day an expiry date ends, and how times are shown. */
  timezone: () => string;
  t: ReturnType<typeof translatorFor<"cli.agentToken">>;
  out: (line: string) => void;
  err: (line: string) => void;
  generate?: typeof generateAgentToken;
}

const nameSchema = z.string().trim().min(1).max(NAME_MAX).regex(/^[^\p{C}]+$/u);
const daySchema = z.iso.date();

function isPreset(value: string): value is keyof typeof PERMISSION_PRESETS {
  return (PRESET_NAMES as string[]).includes(value);
}

/** Permission names and preset names, comma-separated or repeated, in the order of the permission list. */
export function parsePermissionList(values: readonly string[]): { ok: true; permissions: Permission[] } | { ok: false; invalid: string[] } {
  const chosen = new Set<Permission>();
  const invalid: string[] = [];
  for (const item of values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== "")) {
    if (isPreset(item)) PERMISSION_PRESETS[item].forEach((permission) => chosen.add(permission));
    else if (isPermission(item)) chosen.add(item);
    else invalid.push(item);
  }
  if (invalid.length > 0 || chosen.size === 0) return { ok: false, invalid };
  return { ok: true, permissions: PERMISSIONS.filter((permission) => chosen.has(permission)) };
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The first instant after `day` (YYYY-MM-DD) in `timeZone`: a token that expires on that day is valid until the day is over. */
export function endOfDayInZone(day: string, timeZone: string): Date {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
  const guess = next.getTime() - zoneOffsetMs(next, timeZone);
  return new Date(next.getTime() - zoneOffsetMs(new Date(guess), timeZone));
}

function shownTime(at: Date | null, timeZone: string, never: string): string {
  if (at === null) return never;
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

const oneLine = (text: string): string => text.replace(/[\p{C}\s]+/gu, " ").trim();

async function create(input: AgentTokenCliInput, args: string[]): Promise<number> {
  const { t } = input;
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { name: { type: "string" }, permissions: { type: "string", multiple: true }, expires: { type: "string" } },
  });
  if (positionals.length > 0) {
    input.err(t("usage"));
    return EXIT_USAGE;
  }
  const name = nameSchema.safeParse(values.name ?? "");
  if (!name.success) {
    input.err(t("nameInvalid", { max: NAME_MAX }));
    return EXIT_USAGE;
  }
  const permissions = parsePermissionList(values.permissions ?? []);
  if (!permissions.ok) {
    input.err(permissions.invalid.length > 0 ? t("permissionsInvalid", { invalid: permissions.invalid.map(oneLine).join(", ") }) : t("permissionsMissing"));
    input.err(t("permissionsValid", { presets: PRESET_NAMES.join(", "), permissions: PERMISSIONS.join(", ") }));
    return EXIT_USAGE;
  }
  let expiresAt: Date | null = null;
  if (values.expires !== undefined) {
    const day = daySchema.safeParse(values.expires);
    if (!day.success) {
      input.err(t("expiresInvalid"));
      return EXIT_USAGE;
    }
    expiresAt = endOfDayInZone(day.data, input.timezone());
    if (expiresAt.getTime() <= input.now().getTime()) {
      input.err(t("expiresPast"));
      return EXIT_USAGE;
    }
  }
  const token = (input.generate ?? generateAgentToken)();
  const row = await insertAgentToken(input.db, { name: name.data, tokenHash: token.hash, tokenPrefix: token.prefix, permissions: permissions.permissions, expiresAt });
  if (!row) {
    input.err(t("nameTaken", { name: name.data }));
    return EXIT_FAILED;
  }
  input.err(t("created", {
    name: row.name,
    prefix: row.tokenPrefix,
    permissions: row.permissions.join(", "),
    expires: shownTime(row.expiresAt, input.timezone(), t("never")),
    zone: input.timezone(),
  }));
  input.out(token.secret);
  input.err(t("shownOnce", { prefix: row.tokenPrefix }));
  return EXIT_OK;
}

function describe(input: AgentTokenCliInput, token: AgentTokenSummary, now: Date): string {
  const { t } = input;
  const zone = input.timezone();
  return t("row", {
    prefix: token.tokenPrefix,
    name: oneLine(token.name),
    state: t(`state.${agentTokenState(token, now)}`),
    created: shownTime(token.createdAt, zone, t("never")),
    used: shownTime(token.lastUsedAt, zone, t("never")),
    expires: shownTime(token.expiresAt, zone, t("never")),
    permissions: storedPermissions(token.permissions).join(", ") || t("none"),
  });
}

async function list(input: AgentTokenCliInput, args: string[]): Promise<number> {
  parseArgs({ args, strict: true, allowPositionals: false, options: {} });
  const tokens = await listAgentTokens(input.db);
  if (tokens.length === 0) {
    input.err(input.t("empty"));
    return EXIT_OK;
  }
  const now = input.now();
  input.err(input.t("listHeader", { zone: input.timezone() }));
  for (const token of tokens) input.out(describe(input, token, now));
  return EXIT_OK;
}

async function revoke(input: AgentTokenCliInput, args: string[]): Promise<number> {
  const { t } = input;
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
  const key = positionals[0];
  if (positionals.length !== 1 || key === undefined || key.trim() === "") {
    input.err(t("usage"));
    return EXIT_USAGE;
  }
  const matches = await findUnrevokedAgentTokens(input.db, key.trim());
  const [only] = matches;
  if (!only) {
    input.err(t("revokeNone", { key: oneLine(key) }));
    return EXIT_FAILED;
  }
  if (matches.length > 1) {
    input.err(t("revokeAmbiguous", { key: oneLine(key), prefixes: matches.map((token) => token.tokenPrefix).join(", ") }));
    return EXIT_FAILED;
  }
  const revoked = await revokeAgentToken(input.db, only.id, input.now());
  input.err(revoked ? t("revoked", { name: oneLine(only.name), prefix: only.tokenPrefix }) : t("revokeNone", { key: oneLine(key) }));
  return revoked ? EXIT_OK : EXIT_FAILED;
}

export async function runAgentToken(input: AgentTokenCliInput): Promise<number> {
  const [command, ...rest] = input.argv;
  try {
    switch (command) {
      case "create": return await create(input, rest);
      case "list": return await list(input, rest);
      case "revoke": return await revoke(input, rest);
      default:
        input.err(input.t("usage"));
        return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof TypeError && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS")) {
      input.err(input.t("usage"));
      return EXIT_USAGE;
    }
    throw error;
  }
}
