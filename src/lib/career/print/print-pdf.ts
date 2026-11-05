import { chromium, type BrowserContext, type LaunchOptions } from "playwright-core";
import { countPages } from "../engine";

export interface PdfOptions { tagged: boolean; outline: boolean; timeoutMs: number }
export interface Printer {
  print(html: string, opts: PdfOptions): Promise<{ pdf: Uint8Array; pages: number }>;
  close(): Promise<void>;
}

export const PRINT_LAUNCH_ARGS = ["--disable-dev-shm-usage", "--font-render-hinting=none"] as const;

export async function openPrinter(launch?: LaunchOptions): Promise<Printer> {
  const browser = await chromium.launch({ ...launch, args: [...PRINT_LAUNCH_ARGS, ...(launch?.args ?? [])] });
  return {
    async print(html, opts) {
      let context: BrowserContext | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      const work = async () => {
        const created = await browser.newContext({ javaScriptEnabled: false });
        context = created;
        if (expired) {
          await created.close();
          throw new Error("PDF print timed out before context creation");
        }
        await context.route("**/*", (route) => route.abort());
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: "load", timeout: opts.timeoutMs });
        await page.evaluate(() => document.fonts.ready);
        const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: opts.tagged, outline: opts.outline });
        const pdf = new Uint8Array(bytes);
        return { pdf, pages: await countPages(pdf) };
      };
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error(`PDF print timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      });
      try {
        return await Promise.race([work(), deadline]);
      } finally {
        try {
          if (context) await Promise.race([context.close(), deadline]);
        } finally {
          clearTimeout(timer);
        }
      }
    },
    async close() { await browser.close(); },
  };
}
