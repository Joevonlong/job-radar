/** Additional read tools withhold all posting-derived strings until every relevant posting has a current trap scan. */
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import { cleanDescriptionStrict, type JobText } from "@/lib/traps/clean";
import type { McpContext } from "./context";
import { jdQuoteGuard, safeSourceUrl, shortFieldCleaner } from "./guard";
import { readTraps } from "./tools/shared";

function credentialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "" || [...url.searchParams.keys()].some((key) => /(?:^|[_-])(?:key|token|secret|password|auth|authorization|credential|signature|sig)(?:$|[_-])/i.test(key) || /^(?:apiKey|accessKey|accessToken|clientSecret)$/i.test(key));
  } catch {
    return false;
  }
}

/** Free text can contain pasted contact details, filesystem paths or credential assignments. */
export function readTextCleaner(settings: TrapsConfig | null, marker: string) {
  const clean = shortFieldCleaner(settings);
  return (text: string): string => clean(text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (value) => credentialUrl(value) ? marker : value)
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, marker)
    .replace(/file:\/\/[^\s"'<>]+|(?<![\w/:])(?:~[\\/]|\/(?!\/)|[A-Z]:[\\/]|\\\\)[^\s"'<>]+/gi, marker)
    .replace(/\b[A-Z][A-Z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, marker)
    .replace(/\b(?:[\w-]*(?:password|token|secret|(?:api|access|auth)[_-]?key)|database_url)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, marker)
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+)\b/g, marker);
}

export async function readTextAccess(ctx: McpContext, jobs: readonly JobText[]) {
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const scans = await Promise.all(jobs.map(async (job) => ({ job, strict: await cleanDescriptionStrict(ctx.db, job, { settings: ctx.traps }) })));
  const failed = scans.find(({ strict }) => !strict.ok)?.strict;
  const reason = jobs.length === 0 ? "not_scanned" : failed && !failed.ok ? failed.reason : null;
  const guards = scans.map(({ job, strict }) => jdQuoteGuard(strict, job.description));
  return {
    reason,
    clean,
    text: (value: string | null): string | null => {
      if (value === null || reason !== null) return null;
      let result = value;
      for (const guard of guards) {
        const guarded = guard(result, null);
        if (guarded === null) return null;
        result = guarded;
      }
      return clean(result);
    },
  };
}
export type ReadTextAccess = Awaited<ReturnType<typeof readTextAccess>>;

/** Public source links also pass the stored-span guard, not only the short instruction patterns. */
export function readSourceUrl(url: string | null, access: ReadTextAccess): string | null {
  if (url === null || !/^https?:\/\//i.test(url) || credentialUrl(url)) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return safeSourceUrl(url, (text) => access.text(text) ?? "");
}
