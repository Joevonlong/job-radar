/**
 * Passive look at what the subscription CLIs put into their normal output, to learn whether they already report a
 * usage-limit signal (a window, a percentage) that the parsers drop today. Only names are kept: the envelope's key
 * names and the JSONL event / item type names, never a value. Logged at debug level by the transports; no extra call.
 */

const MAX_NAMES = 40;
const MAX_NAME_CHARS = 64;

/** Key names / type names only; anything that does not look like an identifier is left out. */
const NAME = /^[A-Za-z0-9_.:/-]+$/;

function names(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (out.size >= MAX_NAMES) break;
    if (value.length <= MAX_NAME_CHARS && NAME.test(value)) out.add(value);
  }
  return [...out].sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface ClaudeOutputShape {
  /** Top-level keys of the JSON envelope. */
  keys: string[];
  /** Keys of the envelope's `usage` object (empty when there is none). */
  usageKeys: string[];
}

/** The key names of `claude -p --output-format json`'s envelope; null when it is not a JSON object. */
export function claudeOutputShape(stdout: string): ClaudeOutputShape | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const usage = raw.usage;
  return { keys: names(Object.keys(raw)), usageKeys: isRecord(usage) ? names(Object.keys(usage)) : [] };
}

/** The event types the codex parser reads; every other type is what the passive check is after. */
const KNOWN_CODEX_EVENTS = new Set(["item.completed", "turn.completed", "turn.failed", "error"]);

export interface CodexOutputShape {
  /** Every event type seen, in order of first appearance. */
  eventTypes: string[];
  /** Event types the parser does not read, with the key names of their first occurrence. */
  unknownEvents: Record<string, string[]>;
  /** Item types (`item.*` events' `item.type`). */
  itemTypes: string[];
  /** Keys of the `turn.completed` event and of its `usage` (where a limit field would most likely sit). */
  turnCompletedKeys: string[];
  turnUsageKeys: string[];
}

/** The type and key names in the JSONL of `codex exec --json`. */
export function codexOutputShape(stdout: string): CodexOutputShape {
  const eventTypes: string[] = [];
  const unknownEvents: Record<string, string[]> = {};
  const itemTypes = new Set<string>();
  let turnCompletedKeys: string[] = [];
  let turnUsageKeys: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw) || typeof raw.type !== "string") continue;
    const [type] = names([raw.type]);
    if (type === undefined) continue;
    if (!eventTypes.includes(type) && eventTypes.length < MAX_NAMES) eventTypes.push(type);
    if (isRecord(raw.item) && typeof raw.item.type === "string") itemTypes.add(raw.item.type);
    if (type === "turn.completed") {
      turnCompletedKeys = names(Object.keys(raw));
      turnUsageKeys = isRecord(raw.usage) ? names(Object.keys(raw.usage)) : [];
    } else if (!KNOWN_CODEX_EVENTS.has(type) && unknownEvents[type] === undefined && Object.keys(unknownEvents).length < MAX_NAMES) {
      unknownEvents[type] = names(Object.keys(raw));
    }
  }
  return { eventTypes, unknownEvents, itemTypes: names(itemTypes), turnCompletedKeys, turnUsageKeys };
}
