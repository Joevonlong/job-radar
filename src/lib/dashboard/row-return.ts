/**
 * Back from a job to the list lands on the row that was opened: the list remembers the row it left for the detail page (per list
 * URL, in sessionStorage) and the next mount of that same list hands the id back once. A remembered row older than `MAX_AGE_MS` is
 * forgotten: a visit hours later is not "back". Every storage access is wrapped: private windows and blocked storage just mean "no memory".
 */
const KEY = "jr:list-return";
const MAX_AGE_MS = 30 * 60 * 1000;

interface Remembered {
  href: string;
  jobId: number;
  at: number;
}

function hrefOf(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** Call when the user opens a job from the list. */
export function rememberOpenedRow(jobId: number): void {
  try {
    const value: Remembered = { href: hrefOf(), jobId, at: Date.now() };
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* no storage: no memory */
  }
}

/** The job whose row should get the focus on this list, once; null when there is none or it belongs to another list URL. */
export function takeReturnedRow(): number | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<Remembered>;
    if (value.href !== hrefOf() || typeof value.jobId !== "number" || typeof value.at !== "number" || Date.now() - value.at > MAX_AGE_MS) return null;
    window.sessionStorage.removeItem(KEY);
    return value.jobId;
  } catch {
    return null;
  }
}
