/**
 * "Hot reload confirmed". The runner already reloads config files on change; to let the
 * settings page see that, the runner writes the layered fingerprint (user file and shipped file) of what it validated into
 * `runtime_state` (`config_loaded:<name>`), and the page compares it with the fingerprint on
 * disk: equal = the runner runs with exactly what is saved. No new table per feature, no ports.
 */
import { z } from "zod";

import { layeredConfigFingerprint, reloadConfigWithFingerprint } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { listRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

import { ACK_NAMES, type AckName } from "./tabs";

const KEY_PREFIX = "config_loaded:";

const ackValueSchema = z.object({ hash: z.string().min(1), loadedAt: z.iso.datetime() });

export interface ConfigAck {
  hash: string;
  loadedAt: Date;
}

/** Runner side: remember that the validated state with this fingerprint of config `name` is what it runs with now. */
export async function recordConfigLoaded(db: Db, name: AckName, fingerprint: string, now: Date = new Date()): Promise<void> {
  await setRuntimeState(db, `${KEY_PREFIX}${name}`, { hash: fingerprint, loadedAt: now.toISOString() });
}

/** Runner side, at start-up: acknowledge the configs as they are on disk. One that does not validate is skipped: the runner does not run with it. */
export async function recordAllConfigLoaded(db: Db, now: Date = new Date()): Promise<AckName[]> {
  const recorded: AckName[] = [];
  for (const name of ACK_NAMES) {
    let fingerprint: string;
    try {
      fingerprint = reloadConfigWithFingerprint(name).fingerprint;
    } catch {
      continue;
    }
    await recordConfigLoaded(db, name, fingerprint, now);
    recorded.push(name);
  }
  return recorded;
}

/** Web side: what the runner last loaded, per tab (null = never reported). */
export async function readConfigAcks(db: Db): Promise<Record<AckName, ConfigAck | null>> {
  const rows = await listRuntimeState(db, KEY_PREFIX);
  const acks = Object.fromEntries(ACK_NAMES.map((name) => [name, null])) as Record<AckName, ConfigAck | null>;
  for (const row of rows) {
    const name = ACK_NAMES.find((candidate) => `${KEY_PREFIX}${candidate}` === row.key);
    const value = ackValueSchema.safeParse(row.value);
    if (name && value.success) acks[name] = { hash: value.data.hash, loadedAt: new Date(value.data.loadedAt) };
  }
  return acks;
}

export type AckState =
  /** The runner reported exactly what is on disk. */
  | "loaded"
  /** The runner reported something else (not reloaded yet, or the saved file is invalid). */
  | "waiting"
  /** The runner never reported (not started since this feature exists). */
  | "unknown";

export function ackState(diskHash: string | null, ack: ConfigAck | null): AckState {
  if (ack === null) return "unknown";
  return diskHash !== null && diskHash === ack.hash ? "loaded" : "waiting";
}

/** Fingerprint of the config as it is on disk right now, or null when it cannot be read. */
export function diskConfigHash(name: AckName): string | null {
  try {
    return layeredConfigFingerprint(name);
  } catch {
    return null;
  }
}
