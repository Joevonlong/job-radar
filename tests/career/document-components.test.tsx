import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { DocumentContent, DocumentContact } from "@/components/career/document-fields";
import { DocumentPreview } from "@/components/career/document-preview";
import type { CareerDocument } from "@/lib/career/schema/document";
import { document } from "./document-fixtures";

const states = { profileChanged: false, texts: {}, entries: {} };
const wrap = (children: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    {children}
  </NextIntlClientProvider>
);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("sandboxes preview HTML and ignores an obsolete response even if fetch ignores abort", async () => {
  vi.useFakeTimers();
  const requests: { resolve: (value: Response) => void; signal: AbortSignal }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => requests.push({ resolve, signal: init.signal! })),
    ),
  );
  const doc = document();
  const view = render(wrap(<DocumentPreview document={doc} doc="resume" debounceMs={75} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(75);
  });
  expect(requests).toHaveLength(1);
  view.rerender(wrap(<DocumentPreview document={{ ...doc, title: "New title" }} doc="resume" debounceMs={75} />));
  expect(requests[0]!.signal.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(75);
  });
  await act(async () => {
    requests[1]!.resolve(new Response(JSON.stringify({ ok: true, html: "<html><body>new preview</body></html>" })));
  });
  const frame = screen.getByTitle("Document preview");
  expect(frame).toHaveAttribute("sandbox", "");
  expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("new preview"));
  await act(async () => {
    requests[0]!.resolve(new Response(JSON.stringify({ ok: true, html: "old preview" })));
  });
  expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("new preview"));
  expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
  view.unmount();
});

it("debounces changes, translates schema issues, and conceals unknown error codes", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: false,
        error: "render_invalid",
        issues: [
          { code: "career.schema.empty", path: "experience.0.role" },
          { code: "private-sentinel", path: "summary" },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const doc = document();
  const view = render(wrap(<DocumentPreview document={doc} doc="resume" debounceMs={90} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  view.rerender(wrap(<DocumentPreview document={{ ...doc, title: "Changed" }} doc="resume" debounceMs={90} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(89);
  });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toHaveTextContent("Check the value at experience.0.role.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private-sentinel");
});

it("does not request a letter preview until it has body text", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(wrap(<DocumentPreview document={document()} doc="letter" debounceMs={75} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByText("Add a body paragraph to preview your cover letter.")).toBeVisible();
});

it("updates inclusion and order without deleting sourced entries, and marks edited text", () => {
  let current = document();
  current.experience = current.experience.slice(0, 1);
  current.experience[0]!.bullets = current.experience[0]!.bullets.slice(0, 2);
  const original = current.experience[0]!.bullets.map((bullet) => bullet.text);
  function Form() {
    const [doc, setDoc] = useState(current);
    return (
      <DocumentContent
        document={doc}
        states={states}
        onChange={(value) => {
          current = value;
          setDoc(value);
        }}
      />
    );
  }
  render(wrap(<Form />));
  const experience = within(screen.getByTestId("document-experience"));
  const checks = experience.getAllByRole("checkbox", { name: "Include" });
  fireEvent.click(checks[1]!);
  expect(current.experience[0]!.bullets[0]!.included).toBe(false);
  expect(current.experience[0]!.bullets).toHaveLength(2);
  const firstBullet = experience.getByLabelText("Text 1").closest('fieldset[data-testid="document-entry"]')!;
  expect(within(firstBullet as HTMLElement).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  fireEvent.click(within(firstBullet as HTMLElement).getByRole("button", { name: "Move down" }));
  expect(current.experience[0]!.bullets.map((bullet) => bullet.text)).toEqual([...original].reverse());
  fireEvent.change(experience.getByLabelText("Text 1"), { target: { value: "Edited text" } });
  expect(current.experience[0]!.bullets[0]!.origin).toBe("user");
  expect(experience.getByText("Edited", { exact: true })).toBeVisible();
});

it("stores contact field names only and never accepts contact values", () => {
  let current: CareerDocument["hide_contact"] = [];
  function Form() {
    const [value, setValue] = useState(current);
    return (
      <DocumentContact
        value={value}
        onChange={(next) => {
          current = next;
          setValue(next);
        }}
      />
    );
  }
  render(wrap(<Form />));
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide email in this document" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide address in this document" }));
  expect(current).toEqual(["email", "address"]);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide email in this document" }));
  expect(current).toEqual(["address"]);
});

it("adds handwritten entries with empty ids to every document section", () => {
  let current = document();
  function Form() {
    const [doc, setDoc] = useState(current);
    return (
      <DocumentContent
        document={doc}
        states={states}
        onChange={(value) => {
          current = value;
          setDoc(value);
        }}
      />
    );
  }
  render(wrap(<Form />));
  for (const key of [
    "experience",
    "projects",
    "education",
    "certifications",
    "languages",
    "skills",
    "approach",
    "custom_sections",
  ] as const) {
    const previous = current[key].length;
    const section = within(screen.getByTestId(`document-${key}`));
    fireEvent.click(section.getAllByRole("button", { name: "Add entry" }).at(-1)!);
    expect(current[key]).toHaveLength(previous + 1);
    expect(current[key].at(-1)).toMatchObject({ id: "", source: null, included: true });
  }
});
