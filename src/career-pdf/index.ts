import { openPrinter } from "../lib/career/print/print-pdf";
import { createPdfService, serviceSettings } from "./service";

async function main() {
  const parsed = serviceSettings.safeParse(process.env);
  if (!parsed.success) {
    console.log(JSON.stringify({ status: 500, bytes: 0, duration: 0, error: "Error" }));
    process.exitCode = 1;
    return;
  }
  const settings = parsed.data;
  const service = await createPdfService({
    maxHtmlBytes: settings.CAREER_PDF_MAX_HTML_BYTES,
    timeoutMs: settings.CAREER_PDF_TIMEOUT_SECONDS * 1000,
    open: () => openPrinter(),
    log: (entry) => console.log(JSON.stringify(entry)),
  });
  process.once("SIGTERM", () => { void service.close(); });
  process.once("SIGINT", () => { void service.close(); });
  try {
    await new Promise<void>((resolve, reject) => {
      service.server.once("error", reject);
      service.server.listen(settings.CAREER_PDF_PORT, "0.0.0.0", resolve);
    });
  } catch {
    await service.close();
    throw new Error();
  }
}

void main().catch(() => {
  console.log(JSON.stringify({ status: 500, bytes: 0, duration: 0, error: "Error" }));
  process.exitCode = 1;
});
