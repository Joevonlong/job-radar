import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

import * as actions from "@/app/career/documents/actions";
import { POST as preview } from "@/app/api/career/documents/preview/route";
import { POST as pages } from "@/app/api/career/documents/pages/route";
import { POST as exportPdf } from "@/app/api/career/documents/[id]/pdf/route";
import { closeDb } from "@/lib/db";
import { resetConfigCache } from "@/lib/config";
import { saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { saveCareerProfile } from "@/lib/career/store/profile";
import { careerContactPath, careerDir } from "@/lib/career/store/paths";
import { document } from "../career/document-fixtures";
import { profile, tempCareer } from "../career/fixtures";

const databaseUrl = inject("testDatabaseUrl");
const payload = z.strictObject({ html: z.string(), tagged: z.boolean(), outline: z.boolean() });
const pdfBytes = Buffer.from("%PDF-stand-in");
let server: Server;
let serviceUrl: string;
let temp: ReturnType<typeof tempCareer>;
let htmlSent: string[];
let status: number;
let logs: unknown[][];

beforeAll(() => { process.env.DATABASE_URL = databaseUrl; });
beforeEach(async () => {
  htmlSent = [];
  logs = [];
  status = 200;
  server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = payload.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      htmlSent.push(input.html);
      response.writeHead(status, { "Content-Type": "application/pdf", "X-Page-Count": "3" });
      response.end(status === 200 ? pdfBytes : "private-service-error-sentinel");
    })().catch(() => { response.writeHead(400); response.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  serviceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  temp = tempCareer({ pdf: { url: serviceUrl, timeout_seconds: 2, max_html_bytes: 8000000 } });
  for (const method of ["log", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  temp?.cleanup();
});
afterAll(closeDb);

function tree() {
  if (!fs.existsSync(temp.profileDir)) return {};
  return Object.fromEntries(fs.readdirSync(temp.profileDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(temp.profileDir, file), fs.readFileSync(file).toString("base64")];
    }));
}
function request(body: unknown) {
  return new Request("http://localhost/api/career/documents/pages", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function exportSaved(id: string, doc = "resume") {
  return exportPdf(new Request(`http://localhost/api/career/documents/${id}/pdf?doc=${doc}`, { method: "POST" }),
    { params: Promise.resolve({ id }) });
}
async function createSaved() {
  const source = profile();
  source.experience[0]!.start = "2020";
  await saveCareerProfile(source, { baseHash: null });
  const created = await actions.createDocumentAction({ title: "Example" });
  if (!created.ok) throw new Error(created.code);
  const loaded = await actions.loadDocumentAction({ id: created.id });
  if (!loaded.ok) throw new Error(loaded.code);
  return loaded;
}

it.each([[200, null], [429, "pdf_busy"], [500, "pdf_failed"]] as const)(
  "returns a transient page count or a soft failure for service status %s", async (serviceStatus, code) => {
    status = serviceStatus;
    const before = tree();
    const response = await pages(request({ document: document(), doc: "resume" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(code ? { ok: true, pages: null, code } : { ok: true, pages: 3 });
    expect(htmlSent[0]).toContain("<!doctype html>");
    expect(tree()).toEqual(before);
  },
);

it("keeps editing usable when the service is absent and exports a localized error code", async () => {
  const saved = await createSaved();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const before = tree();
  expect(await (await pages(request({ document: saved.document, doc: "resume" }))).json())
    .toEqual({ ok: true, pages: null, code: "pdf_unavailable" });
  const response = await exportSaved(saved.document.id);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, error: "pdf_unavailable" });
  expect((await preview(request({ document: saved.document, doc: "resume" }))).status).toBe(200);
  expect(tree()).toEqual(before);
});

it.each(["en", "de"] as const)(
  "exports saved résumé and letter bytes with distinct names, no-store and no filesystem changes (%s)", async (lang) => {
    const loaded = await createSaved();
    const edited = { ...loaded.document, layout: { ...loaded.document.layout, lang, filename: "Saved_{lang}_{date}" },
      letter: { recipient: [], place: null, date: null, subject: null, salutation: null, closing: null,
        body: [{ id: "", source: null, origin: "user", text: "Saved letter body" }] } };
    const saved = await actions.saveDocumentAction({ id: edited.id, document: edited, baseHash: loaded.baseHash });
    if (!saved.ok) throw new Error(saved.code);
    const before = tree();
    const names: string[] = [];
    for (const doc of ["resume", "letter"]) {
      const response = await exportSaved(saved.document.id, doc);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/pdf");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(pdfBytes);
      names.push(response.headers.get("Content-Disposition")!);
    }
    expect(names[0]).toMatch(new RegExp(`filename="Saved_${lang}_\\d{4}-\\d{2}-\\d{2}\\.pdf"`));
    expect(names[1]).toContain(lang === "de" ? "Anschreiben" : "Cover_Letter");
    expect(names[0]).not.toBe(names[1]);
    expect(htmlSent[1]).toContain("Saved letter body");
    expect(tree()).toEqual(before);
    expect(Object.keys(tree()).filter((name) => /\.(?:pdf|html)$/i.test(name))).toEqual([]);
  },
);

it("rejects invalid ids, queries and empty letters without contacting the service", async () => {
  const saved = await createSaved();
  expect((await exportSaved("../profile")).status).toBe(400);
  for (const query of ["?doc=unknown", "?doc=resume&doc=letter", "?extra=true", ""])
    expect((await exportPdf(new Request(`http://localhost/api/career/documents/id/pdf${query}`, { method: "POST" }),
      { params: Promise.resolve({ id: saved.document.id }) })).status).toBe(400);
  expect(await (await exportSaved(saved.document.id, "letter")).json()).toEqual({ ok: false, error: "letter_missing" });
  expect(htmlSent).toEqual([]);
});

it("gates both routes before reading the request, params, contact or saved files", async () => {
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: false\n");
  const before = tree();
  const read = vi.fn(() => { throw new Error("must not read"); });
  const input = request(null);
  Object.defineProperty(input, "body", { get: read });
  const context = Object.defineProperty({}, "params", { get: read }) as { params: Promise<{ id: string }> };
  for (const response of [await pages(input), await exportPdf(input, context)]) {
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: "disabled" });
  }
  expect(read).not.toHaveBeenCalled();
  expect(tree()).toEqual(before);
  expect(htmlSent).toEqual([]);
});

it("bounds page input and returns safe projection and service failure codes", async () => {
  const saved = await createSaved();
  status = 429;
  expect(await (await exportSaved(saved.document.id)).json()).toEqual({ ok: false, error: "pdf_busy" });
  status = 500;
  const response = await exportSaved(saved.document.id);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ ok: false, error: "pdf_failed" });
  expect((await pages(request({ document: {}, doc: "resume" }))).status).toBe(422);
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), "enabled: true\ndocument:\n  max_request_bytes: 1\n");
  resetConfigCache();
  expect((await pages(request({ document: saved.document, doc: "resume" }))).status).toBe(413);
  expect(JSON.stringify(logs)).not.toContain("private-service-error-sentinel");
});

it("keeps every contact sentinel transient through save, preview, page count and export", async () => {
  const sentinel = "private-contact-sentinel";
  const contact = { ...emptyContact(), name: `${sentinel}-name`, address: `${sentinel}-address`,
    location: `${sentinel}-location`, email: `${sentinel}@example.invalid`, phone: `${sentinel}-phone`,
    work_auth: `${sentinel}-work`, availability: `${sentinel}-availability`,
    links: [{ label: `${sentinel}-link`, url: `https://example.invalid/${sentinel}` }], photo: `${sentinel}.png` };
  await saveContact(contact, { baseHash: null });
  const loaded = await createSaved();
  const saved = await actions.saveDocumentAction({ id: loaded.document.id,
    document: { ...loaded.document, title: "Saved title" }, baseHash: loaded.baseHash });
  if (!saved.ok) throw new Error(saved.code);
  const prefs = await actions.loadPreferencesAction({});
  if (!prefs.ok) throw new Error(prefs.code);
  await actions.savePreferencesAction({ preferences: prefs.preferences, baseHash: prefs.baseHash });
  const before = tree();
  const { html } = await (await preview(request({ document: saved.document, doc: "resume" }))).json() as { html: string };
  expect((await pages(request({ document: saved.document, doc: "resume" }))).status).toBe(200);
  expect((await exportSaved(saved.document.id)).status).toBe(200);
  for (const value of [contact.name, contact.address, contact.email, contact.phone, contact.work_auth,
    contact.availability, contact.links[0]!.url]) {
    expect(html.includes(value), value).toBe(true);
    for (const sent of htmlSent) expect(sent.includes(value), value).toBe(true);
  }
  const location = await pages(request({ document: { ...saved.document, hide_contact: ["address"] }, doc: "resume" }));
  expect(location.status).toBe(200);
  expect(htmlSent.at(-1)).toContain(contact.location);
  const entries = fs.readdirSync(careerDir(), { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((entry) => entry.isFile())) {
    const file = path.join(entry.parentPath, entry.name);
    if (file !== careerContactPath()) expect(fs.readFileSync(file, "utf8")).not.toContain(sentinel);
  }
  const sql = postgres(databaseUrl);
  try {
    const tables = z.array(z.object({ tablename: z.string() })).parse(
      await sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    for (const { tablename } of tables) {
      const rows = await sql`select to_jsonb(record)::text from ${sql(tablename)} as record`;
      expect(JSON.stringify(rows)).not.toContain(sentinel);
    }
  } finally { await sql.end(); }
  expect(tree()).toEqual(before);
  expect(JSON.stringify(logs)).not.toContain(sentinel);
});
