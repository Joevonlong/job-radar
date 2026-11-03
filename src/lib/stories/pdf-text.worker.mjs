/**
 * Reads the text layer of one PDF in its own thread, so the caller can stop it: a crafted file can keep the parser busy
 * without ever giving the event loop back. It writes nothing and posts only the text, or that it failed (the reason from
 * pdf.js may quote the file).
 */
import { parentPort, workerData } from "node:worker_threads";

import { getDocumentProxy } from "unpdf";

async function read({ bytes, maxChars }) {
  const pdf = await getDocumentProxy(bytes, { useSystemFonts: false, verbosity: 0 });
  try {
    const pages = [];
    let length = 0;
    // pages past the limit are not read
    for (let number = 1; number <= pdf.numPages && length <= maxChars; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : ""))
        .join("")
        .replace(/[ \t]+\n/gu, "\n");
      page.cleanup();
      pages.push(text);
      length += text.length;
    }
    return pages.join("\n\n");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

try {
  parentPort.postMessage({ ok: true, text: await read(workerData) });
} catch {
  parentPort.postMessage({ ok: false });
}
