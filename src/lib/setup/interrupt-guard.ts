/**
 * Moments a second Ctrl-C must not cut short in `pnpm run setup`: while a service command runs (recreating containers)
 * and while the runner this command stopped is not back yet. The first Ctrl-C always only aborts (the command then
 * cleans up); scripts/setup.ts exits on a further one only when nothing is held, otherwise it prints the holder's note.
 */
const holds: string[] = [];

/** Hold further interrupts until the returned release is called (idempotent). `note` is printed on a further Ctrl-C. */
export function holdInterrupts(note: string): () => void {
  holds.push(note);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = holds.lastIndexOf(note);
    if (index >= 0) holds.splice(index, 1);
  };
}

export async function withInterruptsHeld<T>(note: string, run: () => Promise<T>): Promise<T> {
  const release = holdInterrupts(note);
  try {
    return await run();
  } finally {
    release();
  }
}

/** The note of the newest hold; null when nothing is held. */
export function heldInterruptNote(): string | null {
  return holds[holds.length - 1] ?? null;
}
