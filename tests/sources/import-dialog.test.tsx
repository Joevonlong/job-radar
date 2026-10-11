import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImportDialog } from "@/components/sources/registry/import-dialog";
import type { ImportIssue } from "@/lib/sources/registry/import";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const actions = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }));
vi.mock("@/app/sources/registry/actions", () => ({ previewSourcesImportAction: actions.preview, applySourcesImportAction: actions.apply }));

const issues: ImportIssue[] = [
  { path: "ats_boards[14].token", code: "bad_token", message: "token must be a plain board slug", target: "Fahrwelle (greenhouse/bad token)" },
  { path: "sources.indeed.max_results", code: "too_small", values: { origin: "number", limit: 0, inclusive: "false" }, message: "Too small: expected number to be >0" },
  { path: "ats_boards[3].enabled", code: "wrong_type", values: { expected: "boolean" }, message: "x", target: "Typo (lever/typo)" },
  { path: "", code: "invalid_yaml_at", values: { line: 2, col: 6, reason: "Nested mappings are not allowed" }, message: "line 2, column 6: Nested mappings are not allowed" },
];

async function open(locale: "en" | "zh") {
  actions.preview.mockResolvedValue({ status: "error", error: "invalid", issues });
  const user = userEvent.setup();
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      <ImportDialog importMaxBytes={524288} />
    </NextIntlClientProvider>,
  );
  await user.click(screen.getByTestId("import-open"));
  await user.type(screen.getByTestId("import-text"), "a: 1");
  await user.click(screen.getByTestId("import-preview"));
  return within(await screen.findByTestId("import-errors"));
}

beforeEach(() => actions.preview.mockReset());

describe("import dialog errors", () => {
  it("names the company and speaks Chinese", async () => {
    const box = await open("zh");
    const lines = box.getAllByTestId("import-issue").map((li) => li.textContent);
    expect(lines[0]).toBe("Fahrwelle (greenhouse/bad token) · token: token 只能是字母、数字、点、下划线和短横线，并且以字母或数字开头。");
    expect(lines[1]).toBe("sources.indeed.max_results: 太小：必须大于 0。");
    expect(lines[2]).toBe("Typo (lever/typo) · enabled: 类型不对：应为 true / false。");
    expect(lines[3]).toBe("（整个文件）: YAML 语法错误，第 2 行第 6 列：Nested mappings are not allowed");
    expect(lines.join("")).not.toContain("ats_boards[");
  });

  it("speaks English and says the position once", async () => {
    const box = await open("en");
    const lines = box.getAllByTestId("import-issue").map((li) => li.textContent);
    expect(lines[1]).toBe("sources.indeed.max_results: Too small: must be greater than 0.");
    expect(lines[3]).toBe("(whole file): Invalid YAML at line 2, column 6: Nested mappings are not allowed");
    expect(lines[3]?.match(/column/g)).toHaveLength(1);
  });
});

describe("import dialog consent", () => {
  it("shows the terms-of-service notice for a channel the import switches on and applies only after the box is ticked", async () => {
    actions.preview.mockResolvedValue({
      status: "preview",
      summary: { channelsEnabled: 1, channelsDisabled: 0, paramsChanged: 0, boardsAdded: 0, boardsRemoved: 0, boardsChanged: 0, otherChanged: 0 },
      changes: [{ group: "channel", target: "indeed", kind: "enabled" }],
      omittedChanges: 0,
      notes: [],
      noChanges: false,
      baseHash: "h1",
      consentChannels: [{ id: "indeed", kind: "scraping" }],
    });
    actions.apply.mockResolvedValue({ status: "done", outcome: "imported" });
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ImportDialog importMaxBytes={524288} />
      </NextIntlClientProvider>,
    );
    await user.click(screen.getByTestId("import-open"));
    await user.type(screen.getByTestId("import-text"), "a: 1");
    await user.click(screen.getByTestId("import-preview"));
    const box = within(await screen.findByTestId("import-consent"));
    expect(box.getByText(/indeed/)).toBeTruthy();
    expect((screen.getByTestId("import-apply") as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByTestId("import-consent-ack"));
    expect((screen.getByTestId("import-apply") as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId("import-apply"));
    expect(actions.apply).toHaveBeenCalledWith(expect.objectContaining({ baseHash: "h1", acknowledged: true }));
  });
});
