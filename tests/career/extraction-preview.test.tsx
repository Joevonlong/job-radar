import fs from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { POST as prepare } from "@/app/api/career/extract/prepare/route";
import { POST as extract } from "@/app/api/career/extract/route";
import { CareerExtraction } from "@/components/career/career-extraction";
import { loadConfig } from "@/lib/config";
import { emptyProfile } from "@/lib/career/schema/profile";
import { outboundFailureSchema, preparedTextSchema } from "@/lib/outbound/preview";
import { tempCareer } from "./fixtures";
import en from "../../messages/en.json";

vi.mock("@/app/career/actions", () => ({ getCareerExtractStatus: vi.fn(), listCareerDrafts: vi.fn(), adoptCareerDraftAction: vi.fn(), discardCareerDraftAction: vi.fn() }));
vi.mock("@/components/control/use-control-request", () => ({ useControlRequest: () => ({ stage: null, queue: null }) }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

const sensitiveLines = ["Address: 00 Imaginary Lane, Fictionville", "Nationality: fictional"];
let temp: ReturnType<typeof tempCareer>;
beforeEach(() => {
  temp = tempCareer({ import: { title_words: ["Resume"], sensitive_labels: ["Address", "Nationality"] } });
});
afterEach(() => { vi.unstubAllGlobals(); temp.cleanup(); });

const request = (text: string) => new Request("http://localhost/api/career/extract/prepare", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
});

it("keeps the browser scenario's sensitive lines and editable evidence in its prepared response", async () => {
  const source = fs.readFileSync(path.resolve("tests/fixtures/career/extraction-preview.txt"), "utf8");
  const response = await prepare(request(source));
  expect(response.status).toBe(200);
  const preview = preparedTextSchema.parse(await response.json());
  expect(preview.highlights.filter((span) => span.kind === "sensitive").map((span) => preview.text.slice(span.start, span.end))).toEqual(sensitiveLines);
  expect(preview.text).toContain("Published 2 reproducible benchmarks.");
});

it("renders sensitive labels from the real prepare and review-again responses", async () => {
  const source = ["Resume", "Fictional Person", "person@example.invalid", "+1 202 555 0100", ...sensitiveLines].join("\n");
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const input = new Request(`http://localhost${url}`, init);
    const response = await (url.endsWith("/prepare") ? prepare(input) : extract(input));
    const body: unknown = await response.clone().json();
    const preview = url.endsWith("/prepare") ? preparedTextSchema.parse(body) : outboundFailureSchema.parse(body);
    const text = preview.text!;
    expect(preview.highlights?.filter((span) => span.kind === "sensitive").map((span) => text.slice(span.start, span.end))).toEqual(sensitiveLines);
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  render(<NextIntlClientProvider locale="en" messages={en}><CareerExtraction view={{ limits: loadConfig("career").import, providers: [], drafts: [], open: null }} profile={emptyProfile()} baseHash={null} dirty={false} onAdopted={vi.fn()} /></NextIntlClientProvider>);
  fireEvent.change(screen.getByTestId("career-extract-source"), { target: { value: source } });
  fireEvent.click(screen.getByRole("button", { name: en.career.extract.preview }));
  await screen.findByTestId("outbound-send");
  expect(within(screen.getByTestId("outbound-highlights")).getAllByText(/Address:|Nationality:/, { selector: "mark" }).map((mark) => mark.textContent)).toEqual(sensitiveLines);
  const text = (screen.getByTestId("outbound-text") as HTMLTextAreaElement).value;
  expect(text).toContain("[email]");
  expect(text).toContain("[phone]");
  fireEvent.change(screen.getByTestId("outbound-text"), { target: { value: `another@example.invalid\n${text}` } });
  fireEvent.click(screen.getByTestId("outbound-send"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveAttribute("data-code", "review_again"));
  expect(within(screen.getByTestId("outbound-highlights")).getAllByText(/Address:|Nationality:/, { selector: "mark" }).map((mark) => mark.textContent)).toEqual(sensitiveLines);
  expect(screen.getByTestId("outbound-text")).toHaveValue(`[email]\n${text}`);
  expect(screen.getByTestId("outbound-text")).toHaveFocus();
  expect(fetch).toHaveBeenCalledTimes(2);
});
