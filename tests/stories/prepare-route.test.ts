// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/me/story-extract/prepare/route";
import { POST as extract } from "@/app/api/me/story-extract/route";
import { reloadConfig, resetConfigCache } from "@/lib/config";
import { makeTempConfig } from "../config/helpers";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => { throw new Error("prepare must not access the database"); }) }));
let temp: ReturnType<typeof makeTempConfig>;
const request = (body: unknown) => new Request("http://localhost/api/me/story-extract/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  temp = makeTempConfig();
  fs.writeFileSync(path.join(temp.configDir, "writer.yaml"), "enabled: true\nimport:\n  title_words: [Biography]\n  sensitive_labels: [Address]\n");
  fs.mkdirSync(temp.profileDir, { recursive: true });
  fs.writeFileSync(path.join(temp.profileDir, "me.yaml"), "summary: Built reliable services for many customers.\nskills: []\nlanguages: []\nyears_experience: 5\ncity: Fictionville\nneeds_visa_sponsorship: false\n");
  resetConfigCache();
});
afterEach(() => temp.cleanup());

it("prepares paste, file and server-built profile without writing or queueing", async () => {
  const text = "Biography\nFictional Person\nprivate@example.invalid\nBuilt reliable services.";
  const form = new FormData(); form.set("file", new File([text], "resume.txt"));
  const before = fs.readdirSync(temp.profileDir);
  for (const input of [request({ text }), new Request("http://localhost/prepare", { method: "POST", body: form }), request({ origin: "profile" })]) {
    const response = await POST(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const preview = await response.json() as { ok: boolean; text: string; truncated: boolean };
    expect(preview).toMatchObject({ ok: true, truncated: false });
    expect(preview.text).not.toContain("private@example.invalid");
    expect(preview.text).not.toContain("Fictional Person");
  }
  expect(fs.readdirSync(temp.profileDir)).toEqual(before);
});

it("uses preview-supplied name and address without repeating phone replacement", async () => {
  const response = await POST(request({ mode: "values", text: "Fictional Person\n99 Fiction Lane\n+49 30 1234-5678", name: "Fictional Person", address: "99 Fiction Lane" }));
  expect(await response.json()).toMatchObject({ text: "[name]\n[address]\n+49 30 1234-5678" });
});

it("checks writer enablement before reading the body", async () => {
  fs.writeFileSync(path.join(temp.configDir, "writer.yaml"), "enabled: false\n");
  resetConfigCache();
  expect(reloadConfig("writer").enabled).toBe(false);
  expect(await (await POST(request({ text: "some source" }))).json()).toEqual({ ok: false, error: "disabled" });
});

it("refuses multipart and profile-only requests at the final boundary", async () => {
  const form = new FormData(); form.set("file", new File(["source text"], "resume.txt"));
  for (const input of [new Request("http://localhost/extract", { method: "POST", body: form }), request({ origin: "profile" })]) {
    expect(await (await extract(input)).json()).toEqual({ ok: false, error: "invalid" });
  }
});
