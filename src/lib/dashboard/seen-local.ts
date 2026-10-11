/**
 * What this tab changed about the seen state, so the list it returns to shows it at once. Opening a job marks it seen on the
 * server, but "back" can redraw the list from the browser's copy of the page; the list reads this note on mount and lays it over the
 * rows (the server's value wins again as soon as it agrees). Per tab (sessionStorage), forgotten after `MAX_AGE_MS`; every storage access
 * is wrapped: private windows and blocked storage just mean "no note".
 */
const KEY = "jr:seen-local";
const MAX_AGE_MS = 30 * 60 * 1000;
/** Only the latest changes matter (the jobs opened from one list visit). */
const MAX_ENTRIES = 200;

type Notes = Record<string, { seen: boolean; at: number }>;

function read(): Notes {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Notes) : {};
  } catch {
    return {};
  }
}

const CHANGE = "jr:seen-local-change";

function write(notes: Notes): void {
  try {
    const entries = Object.entries(notes)
      .filter(([, note]) => typeof note?.at === "number" && Date.now() - note.at <= MAX_AGE_MS)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_ENTRIES);
    if (entries.length === 0) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* no storage: no note */
  }
  window.dispatchEvent(new Event(CHANGE));
}

/** The user saw (or marked unseen) this job in this tab. */
export function noteSeenLocally(jobId: number, seen: boolean): void {
  const notes = read();
  notes[String(jobId)] = { seen, at: Date.now() };
  write(notes);
}

let cachedRaw: string | null = null;
let cachedNotes: ReadonlyMap<number, boolean> = new Map();

/** `useSyncExternalStore`: the notes as one value that stays the same object while the stored text does not change. */
export function seenNotesSnapshot(): ReadonlyMap<number, boolean> {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedNotes = readSeenNotes();
  }
  return cachedNotes;
}

/** `useSyncExternalStore`: called when this tab writes a note. */
export function subscribeSeenNotes(onChange: () => void): () => void {
  window.addEventListener(CHANGE, onChange);
  return () => window.removeEventListener(CHANGE, onChange);
}

/** The recent notes of this tab, by job id. */
export function readSeenNotes(): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const [id, note] of Object.entries(read())) {
    const jobId = Number(id);
    if (Number.isInteger(jobId) && typeof note?.seen === "boolean" && typeof note.at === "number" && Date.now() - note.at <= MAX_AGE_MS) out.set(jobId, note.seen);
  }
  return out;
}

/** The server caught up with these notes: they are not needed any more. */
export function forgetSeenNotes(jobIds: readonly number[]): void {
  if (jobIds.length === 0) return;
  const notes = read();
  let changed = false;
  for (const id of jobIds) {
    if (String(id) in notes) {
      delete notes[String(id)];
      changed = true;
    }
  }
  if (changed) write(notes);
}
