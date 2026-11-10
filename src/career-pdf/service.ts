import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Printer } from "../lib/career/print/print-pdf";

export const serviceSettings = z.object({
  CAREER_PDF_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  CAREER_PDF_MAX_HTML_BYTES: z.coerce.number().int().min(1).max(50000000).default(8000000),
  CAREER_PDF_TIMEOUT_SECONDS: z.coerce.number().positive().max(300).default(60),
});
const input = z.strictObject({
  html: z.string().min(1), tagged: z.boolean().default(true), outline: z.boolean().default(true),
});
const resultSchema = z.object({ pdf: z.instanceof(Uint8Array), pages: z.number().int().positive().safe() });
const errorNames = z.enum(["Error", "TypeError", "RangeError", "TimeoutError", "SyntaxError", "AbortError"]);
export interface PdfLog { status: number; bytes: number; duration: number; error?: string }
export interface ServiceOptions {
  maxHtmlBytes: number;
  timeoutMs: number;
  open: () => Promise<Printer>;
  log: (entry: PdfLog) => void;
}

export async function createPdfService(options: ServiceOptions) {
  let printer: Printer | undefined;
  let busy = false;
  let stopping = false;
  let generation = 0;
  let closing = 0;
  const closePrinter = async (previous: Printer) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    closing++;
    const closed = previous.close().catch(() => undefined).finally(() => {
      closing--;
      if (previous.isConnected()) stopping = true;
    });
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, options.timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const errorName = (error: unknown) => errorNames.safeParse(error instanceof Error ? error.name : "Error").data ?? "Error";
  const discard = async () => {
    const previous = printer;
    printer = undefined;
    generation++;
    if (previous) await closePrinter(previous);
  };
  const connect = async () => {
    if (!printer?.isConnected()) {
      await discard();
      const current = generation;
      const created = await options.open();
      if (stopping || current !== generation) {
        await closePrinter(created);
        throw new DOMException("", "AbortError");
      }
      printer = created;
    }
    return printer;
  };
  try { await connect(); }
  catch (error) { options.log({ status: 503, bytes: 0, duration: 0, error: errorName(error) }); }

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const started = performance.now();
    let bytes = 0;
    let failure: string | undefined;
    response.once("finish", () => options.log({
      status: response.statusCode, bytes, duration: Math.round(performance.now() - started),
      ...(failure ? { error: failure } : {}),
    }));
    const reply = (status: number, code: string) => {
      response.writeHead(status, {
        "Content-Type": "application/json", "Cache-Control": "no-store",
        ...(status >= 400 ? { Connection: "close" } : {}),
      });
      if (status >= 400) response.once("finish", () => request.destroy());
      response.end(JSON.stringify({ error: code }));
    };
    if (request.method === "GET" && request.url === "/health") {
      reply(!stopping && printer?.isConnected() ? 200 : 503, "health");
      return;
    }
    if (request.method !== "POST" || request.url !== "/render") { reply(404, "not_found"); return; }
    if (stopping) { reply(503, "unavailable"); return; }
    if (busy || closing > 0) { reply(429, "busy"); return; }
    busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new DOMException("", "TimeoutError")); }, options.timeoutMs);
    });
    const work = async () => {
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
        reply(415, "invalid"); return;
      }
      const maxBodyBytes = options.maxHtmlBytes * 6 + 1024;
      const declared = z.coerce.number().int().nonnegative().safe().safeParse(request.headers["content-length"]);
      if (declared.success && declared.data > maxBodyBytes) { reply(413, "too_large"); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBodyBytes) { reply(413, "too_large"); return; }
        chunks.push(buffer);
      }
      if (expired) return;
      let raw: unknown;
      try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reply(400, "invalid"); return; }
      const parsed = input.safeParse(raw);
      if (!parsed.success) { reply(400, "invalid"); return; }
      if (Buffer.byteLength(parsed.data.html, "utf8") > options.maxHtmlBytes) { reply(413, "too_large"); return; }
      const active = await connect();
      if (expired) return;
      const result = resultSchema.parse(await active.print(parsed.data.html, {
        tagged: parsed.data.tagged, outline: parsed.data.outline, timeoutMs: options.timeoutMs,
      }));
      if (expired) return;
      response.writeHead(200, {
        "Content-Type": "application/pdf", "X-Page-Count": String(result.pages), "Cache-Control": "no-store",
      });
      response.end(Buffer.from(result.pdf));
    };
    try { await Promise.race([work(), deadline]); }
    catch (error) {
      failure = errorName(error);
      if (!response.headersSent) reply(expired ? 504 : 500, expired ? "timeout" : "failed");
      await discard();
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
  const server = createServer((request, response) => { void handle(request, response); });
  server.requestTimeout = options.timeoutMs;
  server.headersTimeout = options.timeoutMs;
  return {
    server,
    async close() {
      stopping = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await discard();
      server.closeAllConnections();
      await closed;
    },
  };
}
