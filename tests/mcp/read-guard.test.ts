// @vitest-environment node
import { expect, it } from "vitest";
import { readSourceUrl, readTextCleaner } from "@/lib/mcp/read-guard";
import { trapSettings } from "../traps/helpers";

it.each(["https://user:sample@127.0.0.1/jobs", "https://example.invalid/jobs?access_key=sample", "PASSWORD=hidden-value", "TOKEN=hidden-value", "SECRET=hidden-value", "DATABASE_URL=postgres://test:sample@127.0.0.1:1234/test", "password: hidden-value", "API_KEY=hidden-value", "~/Documents/resume.pdf", "/opt/private/resume.pdf", "C:\\Private\\resume.pdf", "file:///etc/private", "sentinel@example.invalid"])("redacts private text %s", (value) => {
  expect(readTextCleaner(trapSettings(), "[redacted]")(value)).toBe("[redacted]");
});
it("preserves ordinary facts and external source links", () => {
  const clean = readTextCleaner(trapSettings(), "[redacted]");
  expect(clean("Python developer at Example, https://example.invalid/jobs/7")).toBe("Python developer at Example, https://example.invalid/jobs/7");
});

it("withholds source URLs replaced by the stored hidden-span guard", () => {
  const url = "https://example.invalid/hidden";
  const access = { reason: null, clean: (text: string) => text, text: (text: string | null) => text === url ? "[hidden text removed]" : text };
  expect(readSourceUrl(url, access)).toBeNull();
  expect(readSourceUrl("https://example.invalid/public", access)).toBe("https://example.invalid/public");
  expect(readSourceUrl("file:///etc/private", access)).toBeNull();
});

it("rejects credential-bearing source URLs", () => {
  const clean = readTextCleaner(trapSettings(), "[redacted]");
  const access = { reason: null, clean, text: (text: string | null) => text === null ? null : clean(text) };
  expect(readSourceUrl("https://user:sample@127.0.0.1/jobs", access)).toBeNull();
  expect(readSourceUrl("https://example.invalid/jobs?access_key=sample", access)).toBeNull();
});
