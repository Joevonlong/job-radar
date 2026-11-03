import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnswerPanel } from "@/components/writer/answer-panel";
import { writerEntryHref } from "@/lib/writer/entry";
import zh from "../messages/zh.json";
import { BaseEditor } from "@/components/writer/base-editor";
import { CoachReview } from "@/components/writer/coach-review";
import { PolishBox } from "@/components/writer/polish-box";
import { ExportAnswers } from "@/components/writer/export-answers";
import { OldCompanyNotice } from "@/components/writer/old-company-notice";
import { ReuseSuggestions } from "@/components/writer/reuse-suggestions";
import { parseStoredCoach } from "@/lib/writer/coach";
import type { WorkbenchQuestion, WorkbenchVersion, WorkbenchView } from "@/lib/writer/view";

import en from "../messages/en.json";

const actions = vi.hoisted(() => ({ find: vi.fn(), saveBase: vi.fn(), refresh: vi.fn(), polish: vi.fn(), coach: vi.fn(), rewrite: vi.fn(), adopt: vi.fn() }));
vi.mock("@/app/jobs/[id]/apply/actions", () => ({
  findSimilarAnswersAction: actions.find,
  saveBaseVersionAction: actions.saveBase,
  polishAnswerAction: actions.polish,
  coachAnswerAction: actions.coach,
  coachRewriteAction: actions.rewrite,
  adoptSuggestionAction: actions.adopt,
}));
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
  selection: { jdPoints: [], useJdText: false, storyIds: [], profile: true, emphasis: "", company: null },
  companyUpdated: false,
  finalVersionId: finalText === null ? null : id * 10,
  versions: finalText === null ? [] : [{ id: id * 10, mode: "manual", variantId: null, text: finalText, sentences: [], counts: { supported: 0, partial: 0, unsupported: 0, framing: 0, user_written: 0, web_unverified: 0 }, parentVersionId: null, coach: null, createdAt: "2026-01-01T00:00:00.000Z", provider: null, model: null }],
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
  for (const action of [actions.polish, actions.coach, actions.rewrite]) action.mockReset().mockResolvedValue({ ok: true, requestId: 7 });
  actions.adopt.mockReset().mockResolvedValue({ ok: true, versionId: 12 });
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

describe("PolishBox", () => {
  const polishView = { ...view([]), limits: { draftMaxChars: 50 } } as unknown as WorkbenchView;
  const sends = vi.fn(() => ["question", "settings", "job", "draft"] as never);

  it("polishes the text with the chosen option, and lists what is sent for that option", async () => {
    const run = vi.fn((call: () => Promise<unknown>) => void call());
    render(wrap(<PolishBox view={polishView} question={question(1, "Why us?", null)} enabled busy={false} sends={sends} run={run} />));
    const button = screen.getByTestId("writer-polish-button");
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByText("Improve my own draft"));
    await userEvent.type(screen.getByTestId("writer-polish-text"), "I built it.");
    await userEvent.selectOptions(screen.getByTestId("writer-polish-option"), "language_only");
    expect(sends).toHaveBeenLastCalledWith("language_only");
    expect(screen.getByTestId("writer-polish-sends")).toHaveTextContent("your text or the answer under review");
    await userEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
    expect(actions.polish).toHaveBeenCalledWith({ jobId: 5, questionId: 1, text: "I built it.", option: "language_only" });
  });

  it("refuses a text over the limit and is off while a request runs or the writer is off", async () => {
    const { rerender } = render(wrap(<PolishBox view={polishView} question={question(1, "Why us?", null)} enabled busy={false} sends={sends} run={vi.fn()} />));
    await userEvent.click(screen.getByText("Improve my own draft"));
    await userEvent.type(screen.getByTestId("writer-polish-text"), "x".repeat(51));
    expect(screen.getByTestId("writer-polish-length")).toHaveTextContent("at most 50 characters");
    expect(screen.getByTestId("writer-polish-button")).toBeDisabled();
    rerender(wrap(<PolishBox view={polishView} question={question(1, "Why us?", null)} enabled={false} busy sends={sends} run={vi.fn()} />));
    expect(screen.getByTestId("writer-polish-text")).toBeDisabled();
  });
});

describe("CoachReview", () => {
  const sentence = (text: string, status = "user_written") => ({ text, newParagraph: false, about: "user" as const, status: status as never, evidence: [], missing: [], needsCheck: [] });
  const reviewed = (coach: unknown): WorkbenchVersion => ({
    id: 3,
    mode: "manual",
    variantId: null,
    text: "I moved the billing service. Errors fell by 40%.",
    sentences: [sentence("I moved the billing service."), sentence("Errors fell by 40%.")],
    counts: { supported: 0, partial: 0, unsupported: 0, framing: 0, user_written: 2, web_unverified: 0 },
    parentVersionId: null,
    coach: parseStoredCoach(coach),
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: null,
    model: null,
  });
  const coach = {
    score: 72,
    dimensions: [
      { id: "answers_question", status: "improve", note: "Half of it." },
      { id: "vibes_check", status: "good", note: "Custom dimension." },
    ],
    suggestions: [
      { sentenceIndex: 1, issue: "Name the project.", sentence: { ...sentence("Errors fell by 40% after the move.", "supported"), evidence: [{ source: "draft", quote: "Errors fell by 40%", problem: null }] } },
      { sentenceIndex: 0, issue: "Say how long.", sentence: { ...sentence("I moved it in two months.", "ai_suggestion_unverified"), needsCheck: ["Kotlin"] } },
    ],
    dropped: { dimensions: 2, suggestions: 1 },
    provider: null,
    model: null,
    promptVersion: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const props = (version: WorkbenchVersion, over: object = {}) => ({ view: view([]), question: question(1, "Why us?", null), version, enabled: true, busy: false, sends: ["question", "draft"] as never, run: vi.fn((call: () => Promise<unknown>) => void call()), onAdopted: vi.fn(), ...over });

  it("an unreviewed version offers the review, says what is sent, and queues it", async () => {
    const p = props(reviewed(null));
    render(wrap(<CoachReview {...p} />));
    expect(screen.getByTestId("writer-coach")).toHaveAttribute("data-reviewed", "false");
    expect(screen.getByTestId("writer-coach-sends")).toHaveTextContent("the question · your text or the answer under review");
    await userEvent.click(screen.getByTestId("writer-coach-button"));
    expect(actions.coach).toHaveBeenCalledWith({ jobId: 5, questionId: 1, versionId: 3 });
  });

  it("shows the score as the AI's judgement, a verdict per dimension and each suggestion with how it was checked", () => {
    render(wrap(<CoachReview {...props(reviewed(coach))} />));
    expect(screen.getByTestId("writer-coach-score")).toHaveTextContent("72 / 100");
    expect(screen.getByTestId("writer-coach-result")).toHaveTextContent("AI judgement");
    const dimensions = within(screen.getByTestId("writer-coach-dimensions")).getAllByRole("listitem");
    expect(dimensions).toHaveLength(2);
    expect(dimensions[0]).toHaveTextContent("Answers the question");
    expect(dimensions[1]).toHaveTextContent("vibes_check");
    const suggestions = screen.getAllByTestId("writer-coach-suggestion");
    expect(suggestions.map((item) => item.getAttribute("data-status"))).toEqual(["supported", "ai_suggestion_unverified"]);
    expect(suggestions[0]).toHaveTextContent("Sentence 2:");
    expect(suggestions[0]).toHaveTextContent("Has evidence");
    expect(suggestions[1]).toHaveTextContent("AI suggestion, unverified");
    expect(suggestions[1]).toHaveTextContent("Check that it is true");
    expect(suggestions[1]).toHaveTextContent("Kotlin");
    expect(screen.getByTestId("writer-coach-dropped")).toHaveTextContent("2 ratings of dimensions that are not configured. Left out: 1 suggestion for a sentence that does not exist.");
  });

  it("adopting a suggestion saves it and opens the new version; the rewrite button queues the whole-answer request", async () => {
    const p = props(reviewed(coach));
    render(wrap(<CoachReview {...p} />));
    await userEvent.click(screen.getAllByTestId("writer-coach-adopt")[1]!);
    await waitFor(() => expect(actions.adopt).toHaveBeenCalledWith({ jobId: 5, questionId: 1, versionId: 3, suggestionIndex: 1 }));
    await waitFor(() => expect(p.onAdopted).toHaveBeenCalledWith(12));
    expect(actions.refresh).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("writer-coach-rewrite"));
    expect(actions.rewrite).toHaveBeenCalledWith({ jobId: 5, questionId: 1, versionId: 3 });
  });

  it("a failed adoption says so and opens nothing", async () => {
    actions.adopt.mockResolvedValue({ ok: false, error: "not_found" });
    const p = props(reviewed(coach));
    render(wrap(<CoachReview {...p} />));
    await userEvent.click(screen.getAllByTestId("writer-coach-adopt")[0]!);
    await waitFor(() => expect(toasts.tone).toHaveBeenCalledWith("error", expect.stringContaining("no longer exists")));
    expect(p.onAdopted).not.toHaveBeenCalled();
  });

  it("is off while a request runs or the writer is off, and a review without suggestions has no rewrite", () => {
    const { rerender } = render(wrap(<CoachReview {...props(reviewed(coach), { busy: true })} />));
    expect(screen.getByTestId("writer-coach-button")).toBeDisabled();
    expect(screen.getByTestId("writer-coach-rewrite")).toBeDisabled();
    rerender(wrap(<CoachReview {...props(reviewed({ ...coach, suggestions: [] }))} />));
    expect(screen.queryByTestId("writer-coach-rewrite")).toBeNull();
    expect(screen.getByTestId("writer-coach-no-suggestions")).toBeVisible();
  });
});

describe("the workbench entry, the evidence notice and the quota pause", () => {
  it("the job page entry leads to the workbench when the writer is on or answers exist, else to the setting that turns it on", () => {
    expect(writerEntryHref({ jobId: 7, enabled: true, questions: 0 })).toBe("/jobs/7/apply");
    expect(writerEntryHref({ jobId: 7, enabled: false, questions: 2 })).toBe("/jobs/7/apply");
    expect(writerEntryHref({ jobId: 7, enabled: false, questions: 0 })).toBe("/settings?tab=workflow");
  });

  const panelView = (...questions: WorkbenchQuestion[]): WorkbenchView =>
    ({ ...view(questions), providers: [], jdPoints: [], stories: [], company: null, profile: { available: false, summary: "", skills: [] }, kinds: { question: { unit: "words", value: 150, variants: 3 }, motivation: { unit: "words", value: 250, variants: 2 } }, limits: { maxQuestions: 10, textMaxChars: 3000, emphasisMaxChars: 500, draftMaxChars: 8000, reuseMinWords: 3 } }) as unknown as WorkbenchView;
  const panel = (q: WorkbenchQuestion, locale: "en" | "zh" = "en") => (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      <AnswerPanel view={panelView(q)} question={q} base={null} onBaseDone={() => {}} enabled timeZone="UTC" />
    </NextIntlClientProvider>
  );

  it.each([["en", "has evidence"], ["zh", "不等于内容属实"]] as const)("every shown version says that evidence is not verification, and promises nothing (%s)", (locale, phrase) => {
    const q = question(1, "Why us?", "I built the service.");
    render(panel(q, locale));
    const note = screen.getByTestId("writer-evidence-note");
    expect(note).toHaveTextContent(locale === "en" ? en.writer.answer.evidenceNote : zh.writer.answer.evidenceNote);
    expect(note.textContent).toContain(phrase.startsWith("has") ? "not that the claim is true" : phrase);
    expect(note.textContent).not.toMatch(/guarantee|never invent|保证|绝不编造/i);
  });

  it.each(["en", "zh"] as const)("a request held back by the usage cap shows the same notice as the breakdown, with the resume time (%s)", (locale) => {
    const q = { ...question(1, "Why us?", null), initialRequest: { state: "failed", error: "quota_guard", detail: null, resumeAt: "2026-01-02T15:30:00.000Z" } } as unknown as WorkbenchQuestion;
    render(panel(q, locale));
    const messages = locale === "en" ? en : zh;
    const text = screen.getByTestId("writer-error").textContent ?? "";
    expect(screen.getByTestId("writer-error")).toHaveAttribute("data-error", "quota_guard");
    // the breakdown's message template, filled the same way: only the wording that carries the time may differ in value, never in kind
    const breakdown = messages.jdBreakdown.error.quota_guard;
    expect(messages.writer.answer.error.quota_guard).toBe(breakdown);
    expect(text).not.toContain("{");
    expect(text).toMatch(locale === "en" ? /Available again after/ : /后可用/);
  });
});
