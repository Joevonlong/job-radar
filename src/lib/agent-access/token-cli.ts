/**
 * `pnpm agent:token create|list|revoke`: the agent tokens of MCP connections that are not the local stdio process. `create` prints
 * the token alone on standard output, once; everything else goes to standard error. Nothing prints a token's hash, and the token
 * cannot be shown again: the database has only its hash.
 */
import { parseArgs } from "node:util";

import type { Executor } from "@/lib/db/executor";
import { findUnrevokedAgentTokens, listAgentTokens, revokeAgentToken, type AgentTokenSummary } from "@/lib/db/repos/agent-tokens";
import type { translatorFor } from "@/lib/i18n/node";

import { isPermission, PERMISSION_PRESETS, PERMISSIONS, type Permission } from "./permissions";
import {
  AGENT_TOKEN_NAME_MAX,
  TOKEN_SHAPED_PATTERN,
  agentTokenState,
  checkAgentTokenRequest,
  createAgentToken,
  generateAgentToken,
  redactTokens,
  storedPermissions,
} from "./tokens";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

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

function shownTime(at: Date | null, timeZone: string, never: string): string {
  if (at === null) return never;
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

export const redact = redactTokens;

const oneLine = (text: string): string => redact(text).replace(/[\p{C}\s]+/gu, " ").trim();

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
  const permissions = parsePermissionList(values.permissions ?? []);
  const zone = input.timezone();
  const checked = checkAgentTokenRequest({ name: values.name ?? "", permissions: permissions.ok ? permissions.permissions : [], expires: values.expires ?? null }, input.now(), zone);
  if (!checked.ok) {
    if (checked.problem === "name_invalid") input.err(t("nameInvalid", { max: AGENT_TOKEN_NAME_MAX }));
    else if (checked.problem === "permissions_missing") {
      const invalid = permissions.ok ? [] : permissions.invalid;
      input.err(invalid.length > 0 ? t("permissionsInvalid", { invalid: invalid.map(oneLine).join(", ") }) : t("permissionsMissing"));
      input.err(t("permissionsValid", { presets: PRESET_NAMES.join(", "), permissions: PERMISSIONS.join(", ") }));
    } else input.err(t(checked.problem === "expires_past" ? "expiresPast" : "expiresInvalid"));
    return EXIT_USAGE;
  }
  const created = await createAgentToken(input.db, checked.value, input.generate ?? generateAgentToken);
  if (!created.ok) {
    input.err(t("nameTaken", { name: oneLine(checked.value.name) }));
    return EXIT_FAILED;
  }
  const { secret, token: row } = created;
  input.err(t(row.expiresAt === null ? "createdNoExpiry" : "created", {
    name: oneLine(row.name),
    prefix: oneLine(row.tokenPrefix),
    permissions: oneLine(row.permissions.join(", ")),
    expires: shownTime(row.expiresAt, zone, t("never")),
    zone: oneLine(zone),
  }));
  input.out(secret);
  input.err(t("shownOnce", { prefix: oneLine(row.tokenPrefix) }));
  return EXIT_OK;
}

function describe(input: AgentTokenCliInput, token: AgentTokenSummary, now: Date): string {
  const { t } = input;
  const zone = input.timezone();
  return t("row", {
    prefix: oneLine(token.tokenPrefix),
    name: oneLine(token.name),
    state: t(`state.${agentTokenState(token, now)}`),
    created: shownTime(token.createdAt, zone, t("never")),
    used: shownTime(token.lastUsedAt, zone, t("neverUsed")),
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
  input.err(input.t("listHeader", { zone: oneLine(input.timezone()) }));
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
  if (TOKEN_SHAPED_PATTERN.test(key)) {
    input.err(t("revokeTokenInvalid"));
    return EXIT_USAGE;
  }
  const matches = await findUnrevokedAgentTokens(input.db, key.trim());
  const [only] = matches;
  if (!only) {
    input.err(t("revokeNone", { key: oneLine(key) }));
    return EXIT_FAILED;
  }
  if (matches.length > 1) {
    input.err(t("revokeAmbiguous", { key: oneLine(key), prefixes: matches.map((token) => oneLine(token.tokenPrefix)).join(", ") }));
    return EXIT_FAILED;
  }
  const revoked = await revokeAgentToken(input.db, only.id, input.now());
  input.err(revoked ? t("revoked", { name: oneLine(only.name), prefix: oneLine(only.tokenPrefix) }) : t("revokeNone", { key: oneLine(key) }));
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
