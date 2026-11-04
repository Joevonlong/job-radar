/**
 * The request body, read only up to `limit` bytes and held in memory, within `timeoutMs`: `null` when it is longer, `"timeout"` when it
 * is not all there by then (a client that sends a byte a minute must not hold the request, and its memory, open).
 */
export async function readBody(request: Request, limit: number, timeoutMs: number): Promise<Uint8Array<ArrayBuffer> | null | "timeout"> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // a stream that fails (the client left) is as good as one that never finishes
    return "timeout";
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return "timeout";
  const body = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}
