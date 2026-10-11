import http from "node:http";
import type { AddressInfo } from "node:net";

import type { TelegramUpdate } from "@/lib/notify/telegram-client";

export const FAKE_TOKEN = "123456:TEST-fake_token";

export interface RecordedCall {
  method: string;
  body: Record<string, unknown>;
}

interface Failure {
  method: string;
  status: number;
  body: unknown;
  /** How many calls still fail. */
  times: number;
}

/**
 * A tiny fake Telegram Bot API for tests: records every call, answers sendMessage / editMessageText /
 * answerCallbackQuery / getMe, and serves queued updates through a real long-poll `getUpdates`.
 */
export class FakeBotApi {
  readonly calls: RecordedCall[] = [];
  private server: http.Server | null = null;
  private nextMessageId = 100;
  private queue: TelegramUpdate[] = [];
  private waiting: Array<{ respond: () => void }> = [];
  private failures: Failure[] = [];
  private pollListeners: Array<() => void> = [];

  /** Base URL to give the client (no trailing slash). */
  url = "";

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => this.handle(request, response, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const w of this.waiting.splice(0)) w.respond();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  reset(): void {
    // polls a previous test left open (cancelled clients) must not take the next test's updates
    this.waiting = [];
    this.pollListeners = [];
    this.calls.length = 0;
    this.queue = [];
    this.failures = [];
    this.nextMessageId = 100;
  }

  /** Calls of one API method, in order. */
  of(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Make the next `times` calls of `method` fail with an HTTP error. */
  failNext(method: string, status: number, body: unknown = { ok: false, error_code: status, description: "fake failure" }, times = 1): void {
    this.failures.push({ method, status, body, times });
  }

  /** Resolves once a long-poll `getUpdates` is being held open by the server (so tests need no timer to line up with it). */
  whenPollWaiting(): Promise<void> {
    if (this.waiting.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.pollListeners.push(resolve));
  }

  pushUpdate(update: TelegramUpdate): void {
    this.queue.push(update);
    for (const w of this.waiting.splice(0)) w.respond();
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse, raw: string): void {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? "");
    if (!match || match[1] !== FAKE_TOKEN) return send(404, { ok: false, error_code: 404, description: "Not Found" });
    const method = match[2] as string;
    const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    this.calls.push({ method, body });

    const failure = this.failures.find((f) => f.method === method && f.times > 0);
    if (failure) {
      failure.times -= 1;
      return send(failure.status, failure.body);
    }
    switch (method) {
      case "sendMessage":
        return send(200, { ok: true, result: { message_id: this.nextMessageId++ } });
      case "editMessageText":
      case "answerCallbackQuery":
        return send(200, { ok: true, result: true });
      case "getMe":
        return send(200, { ok: true, result: { id: 42, username: "job_radar_test_bot" } });
      case "getUpdates": {
        const timeoutMs = Math.min(Number(body.timeout ?? 0), 2) * 1000;
        const answer = (): void => {
          // a client that already hung up must not swallow updates meant for the next poll
          if (response.writableEnded || response.destroyed || request.socket.destroyed) return;
          send(200, { ok: true, result: this.queue.splice(0) });
        };
        if (this.queue.length > 0 || timeoutMs === 0) return answer();
        const waiter = { respond: answer };
        this.waiting.push(waiter);
        for (const listener of this.pollListeners.splice(0)) listener();
        // a client that hung up must not swallow updates meant for the next poll
        response.on("close", () => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
        });
        setTimeout(() => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) {
            this.waiting.splice(i, 1);
            answer();
          }
        }, timeoutMs).unref();
        return;
      }
      default:
        return send(404, { ok: false, error_code: 404, description: "method not found" });
    }
  }
}
