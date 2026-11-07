// @vitest-environment node
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { openPrinter, type Printer } from "@/lib/career/print/print-pdf";
import { createPdfService, serviceSettings, type PdfLog } from "../../src/career-pdf/service";

const sentinel = "private-html-sentinel";
const pdf = new Uint8Array(Buffer.from("%PDF-test"));
const services: Awaited<ReturnType<typeof createPdfService>>[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); });

function fakePrinter(): Printer {
  let connected = true;
  return {
    isConnected: () => connected,
    close: vi.fn(async () => { connected = false; }),
    print: vi.fn(async () => ({ pdf, pages: 2 })),
  };
}

async function start(open = vi.fn(async () => fakePrinter()), timeoutMs = 2000) {
  const logs: PdfLog[] = [];
  const service = await createPdfService({ open, maxHtmlBytes: 1000, timeoutMs, log: (entry) => logs.push(entry) });
  services.push(service);
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const render = (html = sentinel) => fetch(`${url}/render`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html }),
  });
  return { service, url, logs, render, open };
}

it("validates environment limits and defaults without config files", () => {
  expect(serviceSettings.parse({})).toEqual({ CAREER_PDF_PORT: 8090,
    CAREER_PDF_MAX_HTML_BYTES: 8000000, CAREER_PDF_TIMEOUT_SECONDS: 60 });
  for (const value of [{ CAREER_PDF_PORT: "0" }, { CAREER_PDF_MAX_HTML_BYTES: "-1" }, { CAREER_PDF_TIMEOUT_SECONDS: "NaN" }])
    expect(serviceSettings.safeParse(value).success).toBe(false);
});

it("prints bytes, reports health and logs only safe metadata", async () => {
  const fixture = await start();
  expect((await fetch(`${fixture.url}/health`)).status).toBe(200);
  const response = await fixture.render();
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/pdf");
  expect(response.headers.get("X-Page-Count")).toBe("2");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(pdf));
  expect(JSON.stringify(fixture.logs)).not.toContain(sentinel);
  for (const log of fixture.logs) expect(Object.keys(log).sort()).toEqual(["bytes", "duration", "status"]);
});

it("refuses concurrent prints with 429", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<{ pdf: Uint8Array; pages: number }>();
  const printer = fakePrinter();
  printer.print = vi.fn(() => { entered.resolve(); return finish.promise; });
  const fixture = await start(vi.fn(async () => printer));
  const first = fixture.render();
  await entered.promise;
  const second = await fixture.render();
  expect(second.status).toBe(429);
  expect(await second.text()).not.toContain(sentinel);
  finish.resolve({ pdf, pages: 1 });
  expect((await first).status).toBe(200);
});

it("returns sanitized failures and relaunches on the next request", async () => {
  const broken = fakePrinter();
  broken.print = vi.fn().mockRejectedValue(Object.assign(new Error(sentinel), { name: sentinel }));
  const open = vi.fn().mockResolvedValueOnce(broken).mockImplementation(async () => fakePrinter());
  const fixture = await start(open);
  const failure = await fixture.render();
  expect(failure.status).toBe(500);
  expect(await failure.text()).toBe('{"error":"failed"}');
  expect((await fixture.render()).status).toBe(200);
  expect(open).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(fixture.logs)).not.toContain(sentinel);
});

it("detects a disconnected browser and reopens before printing", async () => {
  const first = fakePrinter();
  const open = vi.fn().mockResolvedValueOnce(first).mockImplementation(async () => fakePrinter());
  const fixture = await start(open);
  await first.close();
  expect((await fetch(`${fixture.url}/health`)).status).toBe(503);
  expect((await fixture.render()).status).toBe(200);
  expect(open).toHaveBeenCalledTimes(2);
});

it("times out with 504 and releases the printer for the next request", async () => {
  const first = fakePrinter();
  first.print = vi.fn(() => new Promise<{ pdf: Uint8Array; pages: number }>(() => undefined));
  const open = vi.fn().mockResolvedValueOnce(first).mockImplementation(async () => fakePrinter());
  const fixture = await start(open, 100);
  const response = await fixture.render();
  expect(response.status).toBe(504);
  expect(await response.text()).toBe('{"error":"timeout"}');
  expect(first.close).toHaveBeenCalled();
  expect((await fixture.render()).status).toBe(200);
  expect(JSON.stringify(fixture.logs)).not.toContain(sentinel);
});

it("bounds HTML and the encoded JSON body and rejects invalid protocol input", async () => {
  const fixture = await start();
  for (const html of ["界".repeat(334), sentinel.repeat(1000)]) {
    const response = await fixture.render(html);
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain(sentinel);
  }
  for (const body of ["{", JSON.stringify({ html: sentinel, extra: sentinel })]) {
    const response = await fetch(`${fixture.url}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(sentinel);
  }
  expect((await fetch(`${fixture.url}/render`, { method: "POST", body: sentinel })).status).toBe(415);
});

it.skipIf(!fs.existsSync(chromium.executablePath()))("reopens real Chromium after disconnect without logging HTML", async () => {
  const printers: Printer[] = [];
  const open = vi.fn(async () => {
    const printer = await openPrinter();
    printers.push(printer);
    return printer;
  });
  const fixture = await start(open, 10000);
  const html = `<html><body>${sentinel}</body></html>`;
  expect((await fixture.render(html)).status).toBe(200);
  await printers[0]!.close();
  expect((await fetch(`${fixture.url}/health`)).status).toBe(503);
  const response = await fixture.render(html);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Page-Count")).toBe("1");
  expect(open).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(fixture.logs)).not.toContain(sentinel);
});

it("times out an unfinished upload without retaining the request or logging its content", async () => {
  const fixture = await start(undefined, 100);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${fixture.url}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" },
    }, (response) => {
      response.resume();
      response.once("end", () => { request.destroy(); resolve(response.statusCode!); });
    });
    request.once("error", reject);
    request.write(JSON.stringify({ html: sentinel }).slice(0, -1));
  });
  expect(status).toBe(504);
  expect((await fixture.render()).status).toBe(200);
  expect(JSON.stringify(fixture.logs)).not.toContain(sentinel);
});

it("retries a failed startup and discards a late browser launch after timeout", async () => {
  const late = Promise.withResolvers<Printer>();
  const open = vi.fn().mockRejectedValueOnce(new Error(sentinel)).mockReturnValueOnce(late.promise)
    .mockImplementation(async () => fakePrinter());
  const fixture = await start(open, 100);
  expect((await fetch(`${fixture.url}/health`)).status).toBe(503);
  expect((await fixture.render()).status).toBe(504);
  expect((await fixture.render()).status).toBe(200);
  const printer = fakePrinter();
  late.resolve(printer);
  await vi.waitFor(() => expect(printer.close).toHaveBeenCalled());
  expect((await fetch(`${fixture.url}/health`)).status).toBe(200);
  expect(JSON.stringify(fixture.logs)).not.toContain(sentinel);
});

it("keeps rejecting prints while a timed-out browser is still closing", async () => {
  const first = fakePrinter();
  const finishClose = Promise.withResolvers<void>();
  const close = first.close;
  first.close = vi.fn(async () => { await finishClose.promise; await close(); });
  first.print = vi.fn(() => new Promise<{ pdf: Uint8Array; pages: number }>(() => undefined));
  const open = vi.fn().mockResolvedValueOnce(first).mockImplementation(async () => fakePrinter());
  const fixture = await start(open, 50);
  expect((await fixture.render()).status).toBe(504);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await fixture.render()).status).toBe(429);
  expect(open).toHaveBeenCalledTimes(1);
  finishClose.resolve();
  await vi.waitFor(() => expect(first.isConnected()).toBe(false));
  expect((await fixture.render()).status).toBe(200);
});
