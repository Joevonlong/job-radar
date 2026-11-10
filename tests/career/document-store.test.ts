import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createDocument, listDocumentVersions, loadDocument, saveDocument } from "@/lib/career/store/documents";
import { careerDir, careerDocumentHistoryDir } from "@/lib/career/store/paths";
import { setConfigWriteLockProviderForTests } from "@/lib/config/write-lock";
import { inProcessConfigWriteLock } from "../config/in-process-lock";
import { tempCareer } from "./fixtures";
import { document } from "./document-fixtures";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => { temp = tempCareer(); });
afterEach(() => {
  setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
  temp.cleanup();
});
it("reports a history failure after a successful document commit", async () => {
  const doc = document();
  fs.mkdirSync(path.dirname(careerDocumentHistoryDir(doc.id)), { recursive: true });
  fs.writeFileSync(careerDocumentHistoryDir(doc.id), "not a directory");
  const created = await createDocument(doc);
  expect(created.warnings).toEqual(["history_failed"]);
  expect((await loadDocument(doc.id)).baseHash).toBe(created.baseHash);
});
it("does not resurrect document history after deletion between config locks", async () => {
  const created = await createDocument(document());
  let acquired = 0;
  setConfigWriteLockProviderForTests(async (options) => {
    acquired++;
    if (acquired === 2) fs.rmSync(careerDir(), { recursive: true, force: true });
    return inProcessConfigWriteLock(options);
  });
  expect(await saveDocument(created.document.id, { ...created.document, title: "Edited" }, { baseHash: created.baseHash })).toMatchObject({ ok: true, warnings: [] });
  expect(acquired).toBe(2);
  expect(fs.existsSync(careerDir())).toBe(false);
  expect(await listDocumentVersions(created.document.id)).toEqual([]);
});
it("returns the committed document even when config becomes invalid during the commit lock", async () => {
  const created = await createDocument(document());
  let acquired = 0;
  setConfigWriteLockProviderForTests(async (options) => {
    acquired++;
    if (acquired === 1) fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "private-sentinel: [broken");
    return inProcessConfigWriteLock(options);
  });
  const saved = await saveDocument(created.document.id, { ...created.document, title: "Edited" }, { baseHash: created.baseHash });
  expect(saved).toMatchObject({ ok: true, document: { title: "Edited" }, warnings: [] });
  expect((await loadDocument(created.document.id)).document.title).toBe("Edited");
});
