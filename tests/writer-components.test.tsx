import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseEditor } from "@/components/writer/base-editor";
import { ExportAnswers } from "@/components/writer/export-answers";
import { OldCompanyNotice } from "@/components/writer/old-company-notice";
import { ReuseSuggestions } from "@/components/writer/reuse-suggestions";
import type { WorkbenchQuestion, WorkbenchView } from "@/lib/writer/view";

import en from "../messages/en.json";

const actions = vi.hoisted(() => ({ find: vi.fn(), saveBase: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/jobs/[id]/apply/actions", () => ({ findSimilarAnswersAction: actions.find, saveBaseVersionAction: actions.saveBase }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }), unstable_isUnrecognizedActionError: () => false }));
const toasts = vi.hoisted(() => ({ tone: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastTone: toasts.tone }));

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

const question = (id: number, text: string, finalText: string | null): WorkbenchQuestion => ({
  id,
  text,
  kind: "question",
  lengthUnit: "words",
  lengthValue: 150,
  outputLanguage: "en",
  tone: "neutral",
  selection: { jdPoints: [], useJdText: false, storyIds: [], profile: true, emphasis: "" },
  finalVersionId: finalText === null ? null : id * 10,
  versions: finalText === null ? [] : [{ id: id * 10, mode: "manual", variantId: null, text: finalText, sentences: [], counts: { supported: 0, partial: 0, unsupported: 0, framing: 0, user_written: 0, web_unverified: 0 }, createdAt: "2026-01-01T00:00:00.000Z", provider: null, model: null }],
  initialRequest: null,
  startedFrom: [],
  stale: { jdPoints: 0, stories: 0 },
});

const view = (questions: WorkbenchQuestion[]): WorkbenchView =>
  ({ job: { id: 5, title: "Backend Engineer", company: "Acme GmbH", companyNames: ["Acme GmbH", "acme"], hasDescription: true }, availability: "enabled", questions }) as unknown as WorkbenchView;

beforeEach(() => {
  actions.find.mockReset();
  actions.saveBase.mockReset().mockResolvedValue({ ok: true, versionId: 9 });
  actions.refresh.mockReset();
  toasts.tone.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("ExportAnswers", () => {
  it("is off until a question has a final answer, and says why", () => {
    render(wrap(<ExportAnswers view={view([question(1, "Why us?", null)])} />));
    expect(screen.getByTestId("writer-export-button")).toBeDisabled();
    expect(screen.getByTestId("writer-export-count")).toHaveTextContent("0 of 1 with a final answer");
  });

  it("downloads one Markdown file of the final answers, built in the browser", async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(wrap(<ExportAnswers view={view([question(1, "Why us?", "Because of the product."), question(2, "Open", null)])} />));
    expect(screen.getByTestId("writer-export-count")).toHaveTextContent("1 of 2 with a final answer");
    await user.click(screen.getByTestId("writer-export-button"));

    expect(names).toEqual(["acme-gmbh-backend-engineer-answers.md"]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe("text/markdown;charset=utf-8");
    const text = await blobs[0]!.text();
    expect(text).toContain("# Application answers");
    expect(text).toContain("Backend Engineer · Acme GmbH");
    expect(text).toContain("> Why us?");
    expect(text).toContain("Because of the product.");
    expect(text).not.toContain("Open");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toasts.tone).toHaveBeenCalledWith("success", "Exported 1 answer");
  });
});

describe("ReuseSuggestions", () => {
  const match = { versionId: 31, question: "Why do you want to join Initech?", answer: "Initech answer", company: "Initech", companyNames: ["Initech"], jobTitle: "SRE", percent: 72 };

  it("looks up the earlier answers after a pause and offers them, and starts from the one you pick", async () => {
    const user = userEvent.setup();
    actions.find.mockResolvedValue({ ok: true, matches: [match] });
    const onUse = vi.fn();
    render(wrap(<ReuseSuggestions jobId={5} minWords={3} text="Why do you want to join us?" enabled disabled={false} onUse={onUse} />));
    expect(actions.find).not.toHaveBeenCalled();
    const list = await screen.findByTestId("writer-reuse", {}, { timeout: 3000 });
    expect(actions.find).toHaveBeenCalledTimes(1);
    expect(actions.find).toHaveBeenCalledWith({ jobId: 5, text: "Why do you want to join us?" });
    expect(within(list).getByTestId("writer-reuse-match")).toHaveTextContent("Initech · SRE · 72% of the words in common");
    await user.click(within(list).getByTestId("writer-reuse-use"));
    expect(onUse).toHaveBeenCalledWith(match);
  });

  it("shows nothing for a short text or when nothing is similar, and does not look up while off", async () => {
    actions.find.mockResolvedValue({ ok: true, matches: [] });
    const { rerender } = render(wrap(<ReuseSuggestions jobId={5} minWords={3} text="Why us" enabled disabled={false} onUse={vi.fn()} />));
    rerender(wrap(<ReuseSuggestions jobId={5} minWords={3} text="Why do you want to join us?" enabled disabled={false} onUse={vi.fn()} />));
    await waitFor(() => expect(actions.find).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(screen.queryByTestId("writer-reuse")).toBeNull();

    actions.find.mockClear();
    rerender(wrap(<ReuseSuggestions jobId={5} minWords={3} text="Another long enough question text" enabled={false} disabled={false} onUse={vi.fn()} />));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(actions.find).not.toHaveBeenCalled();
  });

  it("counts words, not characters: a short Chinese question is looked up, a two-word one is not", async () => {
    actions.find.mockResolvedValue({ ok: true, matches: [match] });
    // "请介绍一下你自己" is 8 characters (under any character minimum) but 8 words
    render(wrap(<ReuseSuggestions jobId={5} minWords={3} text="请介绍一下你自己" enabled disabled={false} onUse={vi.fn()} />));
    await screen.findByTestId("writer-reuse", {}, { timeout: 3000 });
    expect(actions.find).toHaveBeenCalledWith({ jobId: 5, text: "请介绍一下你自己" });
  });

  it("the minimum comes from the page: two words are enough when it says so, three are not enough when it asks for four", async () => {
    actions.find.mockResolvedValue({ ok: true, matches: [] });
    const { rerender } = render(wrap(<ReuseSuggestions jobId={5} minWords={2} text="Why us?" enabled disabled={false} onUse={vi.fn()} />));
    await waitFor(() => expect(actions.find).toHaveBeenCalledTimes(1), { timeout: 3000 });
    actions.find.mockClear();
    rerender(wrap(<ReuseSuggestions jobId={5} minWords={4} text="Why us here" enabled disabled={false} onUse={vi.fn()} />));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(actions.find).not.toHaveBeenCalled();
  });

  it("hides the offers of an older text as soon as the text changes", async () => {
    actions.find.mockResolvedValue({ ok: true, matches: [match] });
    const { rerender } = render(wrap(<ReuseSuggestions jobId={5} minWords={3} text="Why do you want to join us?" enabled disabled={false} onUse={vi.fn()} />));
    await screen.findByTestId("writer-reuse", {}, { timeout: 3000 });
    rerender(wrap(<ReuseSuggestions jobId={5} minWords={3} text="Why do you want to join us? Be honest" enabled disabled={false} onUse={vi.fn()} />));
    expect(screen.queryByTestId("writer-reuse")).toBeNull();
  });
});

describe("OldCompanyNotice and BaseEditor", () => {
  it("warns while the text still names the company of the answer it came from, not the job's own", () => {
    const { rerender } = render(wrap(<OldCompanyNotice text="I would love to join Initech." from={[{ company: "Initech", names: ["Initech"] }]} currentNames={["Acme GmbH", "acme"]} />));
    expect(screen.getByTestId("writer-old-company")).toHaveTextContent("still names Initech");
    rerender(wrap(<OldCompanyNotice text="I would love to join the team." from={[{ company: "Initech", names: ["Initech"] }]} currentNames={["Acme GmbH", "acme"]} />));
    expect(screen.queryByTestId("writer-old-company")).toBeNull();
    rerender(wrap(<OldCompanyNotice text="I would love to join Initech." from={[{ company: "Initech", names: ["Initech"] }]} currentNames={["Initech"]} />));
    expect(screen.queryByTestId("writer-old-company")).toBeNull();
    // the earlier company under its short name, with the legal form only in the stored name
    rerender(wrap(<OldCompanyNotice text="I love Acme" from={[{ company: "Acme Inc.", names: ["Acme Inc.", "acme"] }]} currentNames={["Globex"]} />));
    expect(screen.getByTestId("writer-old-company")).toHaveTextContent("still names Acme Inc.");
  });

  const base = { questionId: 7, sourceVersionId: 31, text: "I would love to join Initech.", company: "Initech", companyNames: ["Initech"], jobTitle: "SRE" };

  it("fills the editor with the earlier answer, warns about its company, and saves it as the first version only on request", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(wrap(<BaseEditor view={view([])} question={question(7, "Why us?", null)} base={base} enabled onDone={onDone} />));
    const field = screen.getByTestId("writer-base-text");
    expect(field).toHaveValue("I would love to join Initech.");
    expect(screen.getByTestId("writer-old-company")).toBeVisible();
    expect(actions.saveBase).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, "I would love to join Acme.");
    expect(screen.queryByTestId("writer-old-company")).toBeNull();
    await user.click(screen.getByTestId("writer-base-save"));
    expect(actions.saveBase).toHaveBeenCalledWith({ jobId: 5, questionId: 7, sourceVersionId: 31, text: "I would love to join Acme." });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(actions.refresh).toHaveBeenCalled();
  });

  it("discarding stores nothing, and a failed save keeps the editor open", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const first = render(wrap(<BaseEditor view={view([])} question={question(7, "Why us?", null)} base={base} enabled onDone={onDone} />));
    await user.click(screen.getByTestId("writer-base-discard"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(actions.saveBase).not.toHaveBeenCalled();
    first.unmount();

    actions.saveBase.mockResolvedValue({ ok: false, error: "not_found" });
    onDone.mockClear();
    render(wrap(<BaseEditor view={view([])} question={question(7, "Why us?", null)} base={base} enabled onDone={onDone} />));
    await user.click(screen.getByTestId("writer-base-save"));
    await waitFor(() => expect(toasts.tone).toHaveBeenCalledWith("error", expect.stringContaining("no longer exists")));
    expect(onDone).not.toHaveBeenCalled();
  });
});
