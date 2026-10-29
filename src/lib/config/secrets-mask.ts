/**
 * C4: sources.yaml can carry proxy URLs with a user name and password (`jobspy.proxies`). The advanced editor
 * shows them as `***:***@`, and a save puts the real text back at the same place. It never lets them be changed there:
 * credentials belong in the file itself (or `.env`), not in a web form.
 */
import { isMap, isScalar, isSeq } from "yaml";

import { maskCredentialsInText } from "@/lib/sources/registry/import";

import type { ConfigName } from "./registry";
import { parseConfigYamlDocument } from "./yaml-options";

interface ProxyItem {
  start: number;
  end: number;
}

/** Source ranges of the items of `jobspy.proxies` (null: the text does not parse, or has no such list). */
function proxyItems(text: string): ProxyItem[] | null {
  const doc = parseConfigYamlDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const jobspy = doc.contents.get("jobspy", true);
  if (!isMap(jobspy)) return null;
  const proxies = jobspy.get("proxies", true);
  if (!isSeq(proxies)) return null;
  const items: ProxyItem[] = [];
  for (const item of proxies.items) {
    if (!isScalar(item) || !item.range) return null;
    items.push({ start: item.range[0], end: item.range[1] });
  }
  return items;
}

function replaceRanges(text: string, items: readonly ProxyItem[], replacement: (source: string, index: number) => string): string {
  let out = text;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    out = out.slice(0, item.start) + replacement(text.slice(item.start, item.end), i) + out.slice(item.end);
  }
  return out;
}

/**
 * The text as the editor shows it: the credentials of every `jobspy.proxies` entry are `***`. Other files are returned as they are.
 * When the proxy entries cannot be located (a syntax error, a YAML alias or anchor, a non-text item), the credentials of EVERY URL in the
 * text are masked instead: the editor never gets the real text back because the structure was unusual.
 */
export function maskConfigText(name: ConfigName, text: string): string {
  if (name !== "channels") return text;
  const items = proxyItems(text);
  return items === null ? maskCredentialsInText(text) : replaceRanges(text, items, (source) => maskCredentialsInText(source));
}

/** The same pattern `maskCredentialsInText` uses: `scheme://` and what sits before the `@`. */
const CREDENTIALS_IN_URL = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s@/"'`]+)@/gi;
const MASK = "***:***";

/** Restore for text masked by pattern (see `maskConfigText`): the k-th `scheme://***:***@` goes back to the k-th original. */
function restoreByPattern(submitted: string, current: string): RestoreResult {
  const originals = [...current.matchAll(CREDENTIALS_IN_URL)];
  const sent = [...submitted.matchAll(CREDENTIALS_IN_URL)];
  if (originals.length !== sent.length) return { ok: false, reason: "proxies_changed" };
  for (const [i, match] of sent.entries()) {
    if (match[2] !== MASK || match[1]?.toLowerCase() !== originals[i]?.[1]?.toLowerCase()) return { ok: false, reason: "proxies_changed" };
  }
  let out = submitted;
  for (let i = sent.length - 1; i >= 0; i--) {
    const match = sent[i];
    const original = originals[i];
    if (!match || !original || match.index === undefined) continue;
    out = out.slice(0, match.index) + original[0] + out.slice(match.index + match[0].length);
  }
  return { ok: true, text: out };
}

export type RestoreResult = { ok: true; text: string } | { ok: false; reason: "proxies_changed" };

/**
 * The text to save: `submitted` (what the editor sent) with each masked proxy entry replaced by the entry of `current`
 * (the file on disk) at the same position. An entry that is not exactly the masked form of the current one, an added
 * or a removed entry is refused. Text whose entries cannot be located (a syntax error, aliases) is restored by pattern: each
 * masked `scheme://***:***@` returns to the original at the same position, anything else touching a credential is refused.
 */
export function restoreMaskedText(name: ConfigName, submitted: string, current: string): RestoreResult {
  if (name !== "channels") return { ok: true, text: submitted };
  const sent = proxyItems(submitted);
  const now = proxyItems(current);
  // Either side without locatable proxy entries: the editor text was masked by pattern, so it is restored by pattern.
  if (sent === null || now === null) return restoreByPattern(submitted, current);
  if (sent.length !== now.length) return { ok: false, reason: "proxies_changed" };
  let changed = false;
  const currentSources = now.map((item) => current.slice(item.start, item.end));
  for (const [i, item] of sent.entries()) {
    const original = currentSources[i] ?? "";
    if (submitted.slice(item.start, item.end) !== maskCredentialsInText(original)) changed = true;
  }
  if (changed) return { ok: false, reason: "proxies_changed" };
  return { ok: true, text: replaceRanges(submitted, sent, (_source, index) => currentSources[index] ?? "") };
}
