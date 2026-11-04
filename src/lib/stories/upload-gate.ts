/**
 * How many résumé uploads are being read at once in this process. Each one holds its file in memory and may start a PDF thread, so a
 * flood of requests is turned away instead of read side by side. Server only.
 */
let active = 0;

/** A slot to give back with the returned function, or null when `limit` uploads are already being read. */
export function enterUpload(limit: number): (() => void) | null {
  if (active >= limit) return null;
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
  };
}
