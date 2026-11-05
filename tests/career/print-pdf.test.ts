// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openPrinter, PRINT_LAUNCH_ARGS } from "../../src/lib/career/print/print-pdf";

const { launch, countPages } = vi.hoisted(() => ({ launch: vi.fn(), countPages: vi.fn() }));

vi.mock("playwright-core", () => ({ chromium: { launch } }));
vi.mock("../../src/lib/career/engine", () => ({ countPages }));

function fakeBrowser() {
  const page = {
    setContent: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    pdf: vi.fn().mockResolvedValue(Buffer.from("pdf")),
  };
  const context = {
    route: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { page, context, browser };
}

const options = { tagged: true, outline: true, timeoutMs: 50 };
let fake: ReturnType<typeof fakeBrowser>;

beforeEach(() => {
  vi.useFakeTimers();
  fake = fakeBrowser();
  launch.mockReset().mockResolvedValue(fake.browser);
  countPages.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  try {
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe("PDF printer", () => {
  test("a timeout while creating a context closes it when it arrives", async () => {
    const pending = Promise.withResolvers<typeof fake.context>();
    fake.browser.newContext.mockReturnValueOnce(pending.promise);
    const printer = await openPrinter();
    const result = printer.print("resume", options);
    const rejected = expect(result).rejects.toThrow("PDF print timed out after 50ms");

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fake.context.close).not.toHaveBeenCalled();

    pending.resolve(fake.context);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(fake.context.newPage).not.toHaveBeenCalled();
    await printer.close();
  });

  test("a timeout during PDF generation closes the context", async () => {
    const pending = Promise.withResolvers<Buffer>();
    fake.page.pdf.mockReturnValueOnce(pending.promise);
    const printer = await openPrinter();
    const result = printer.print("resume", options);
    const rejected = expect(result).rejects.toThrow("PDF print timed out after 50ms");

    await vi.advanceTimersByTimeAsync(0);
    expect(fake.page.pdf).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    pending.resolve(Buffer.from("late pdf"));
    await vi.advanceTimersByTimeAsync(0);
    await printer.close();
  });

  test("PDF generation errors close the context and preserve the error", async () => {
    const error = new Error("PDF generation failed");
    fake.page.pdf.mockRejectedValueOnce(error);
    const printer = await openPrinter();

    await expect(printer.print("resume", options)).rejects.toBe(error);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    await printer.close();
  });

  test("a context close that never resolves cannot hold the print past its deadline", async () => {
    const pending = Promise.withResolvers<void>();
    fake.context.close.mockReturnValueOnce(pending.promise);
    const printer = await openPrinter();
    const result = printer.print("resume", options);
    const rejected = expect(result).rejects.toThrow("PDF print timed out after 50ms");

    await vi.advanceTimersByTimeAsync(0);
    expect(countPages).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    await printer.close();
  });

  test("the same printer can print successfully after a timeout", async () => {
    const pending = Promise.withResolvers<Buffer>();
    fake.page.pdf.mockReturnValueOnce(pending.promise);
    const printer = await openPrinter();
    const first = printer.print("first resume", options);
    const rejected = expect(first).rejects.toThrow("PDF print timed out after 50ms");

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    const next = fakeBrowser();
    fake.browser.newContext.mockResolvedValueOnce(next.context);
    await expect(printer.print("next resume", options)).resolves.toEqual({ pdf: new Uint8Array(Buffer.from("pdf")), pages: 1 });
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(next.context.close).toHaveBeenCalledTimes(1);
    expect(next.page.setContent).toHaveBeenCalledWith("next resume", { waitUntil: "load", timeout: 50 });
    pending.resolve(Buffer.from("late pdf"));
    await vi.advanceTimersByTimeAsync(0);
    await printer.close();
  });

  test("launch arguments start with the print defaults and append caller arguments", async () => {
    const printer = await openPrinter({ headless: true, args: ["--caller-arg", "--another-arg"] });

    expect(launch).toHaveBeenCalledWith({ headless: true, args: [...PRINT_LAUNCH_ARGS, "--caller-arg", "--another-arg"] });
    await printer.close();
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });
});
