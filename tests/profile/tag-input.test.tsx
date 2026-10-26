/** The tag box: a repeated entry is refused with a notice (the typed text stays), the dedupe modes, and input-method guards. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TagInput, type TagDedupe } from "@/components/profile/fields";

import en from "../../messages/en.json";

interface HarnessProps {
  initial?: string[];
  dedupe?: TagDedupe;
  commitOnComma?: boolean;
  onChange?: (next: string[]) => void;
}

function Harness({ initial = [], dedupe, commitOnComma, onChange }: HarnessProps) {
  const [values, setValues] = useState(initial);
  return (
    <>
      <TagInput
        id="t"
        values={values}
        invalid={false}
        onChange={(next) => {
          setValues(next);
          onChange?.(next);
        }}
        {...(dedupe === undefined ? {} : { dedupe })}
        {...(commitOnComma === undefined ? {} : { commitOnComma })}
      />
      <output data-testid="values">{JSON.stringify(values)}</output>
      <button type="button">elsewhere</button>
    </>
  );
}

const renderTags = (props: HarnessProps = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <Harness {...props} />
    </NextIntlClientProvider>,
  );

const input = () => screen.getByRole("textbox");
const values = () => JSON.parse(screen.getByTestId("values").textContent ?? "[]") as string[];
const notice = () => screen.getByTestId("tag-duplicate");

afterEach(() => vi.useRealTimers());

describe("TagInput: adding", () => {
  it("adds a new entry on Enter and on a comma, and clears the box", async () => {
    const user = userEvent.setup();
    renderTags();
    await user.type(input(), "Alpha{Enter}");
    expect(values()).toEqual(["Alpha"]);
    expect(input()).toHaveValue("");
    await user.type(input(), "Beta,");
    expect(values()).toEqual(["Alpha", "Beta"]);
    expect(input()).toHaveValue("");
    expect(notice()).toHaveTextContent("");
  });

  it("adds the typed text when the box loses focus", async () => {
    const user = userEvent.setup();
    renderTags();
    await user.type(input(), "Gamma");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(values()).toEqual(["Gamma"]);
  });

  it("puts a comma into the text when commitOnComma is off", async () => {
    const user = userEvent.setup();
    renderTags({ commitOnComma: false });
    await user.type(input(), "one, two");
    expect(input()).toHaveValue("one, two");
    expect(values()).toEqual([]);
    await user.type(input(), "{Enter}");
    expect(values()).toEqual(["one, two"]);
  });

  it("keeps the notice region mounted with a polite live region, not tied to the input", () => {
    renderTags();
    expect(notice()).toHaveAttribute("aria-live", "polite");
    expect(input()).not.toHaveAttribute("aria-describedby", expect.stringContaining("duplicate"));
  });
});

describe("TagInput: a repeated entry", () => {
  it.each([
    ["the same text", "Applied AI Engineer"],
    ["another case", "applied ai engineer"],
    ["surrounding spaces", "  Applied AI Engineer  "],
  ])("is not added for %s; the text stays and the existing entry is named", async (_name, typed) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTags({ initial: ["ML Engineer", "Applied AI Engineer"], onChange });
    await user.type(input(), `${typed}{Enter}`);
    expect(onChange).not.toHaveBeenCalled();
    expect(values()).toEqual(["ML Engineer", "Applied AI Engineer"]);
    expect(input()).toHaveValue(typed);
    expect(notice()).toHaveTextContent("Already in the list: Applied AI Engineer");
  });

  it("compares NFC-normalised, so a decomposed accent matches the composed one", async () => {
    const user = userEvent.setup();
    renderTags({ initial: ["Düsseldorf"] });
    await user.type(input(), `${"Düsseldorf"}{Enter}`);
    expect(values()).toEqual(["Düsseldorf"]);
    expect(notice()).toHaveTextContent("Already in the list: Düsseldorf");
  });

  it("still prevents the default of Enter and of a comma (no implicit form submit)", () => {
    renderTags({ initial: ["Alpha"] });
    fireEvent.change(input(), { target: { value: "alpha" } });
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(input(), { key: "," })).toBe(false);
    expect(values()).toEqual(["Alpha"]);
  });

  it("highlights the existing chip for a moment, and not on blur", () => {
    vi.useFakeTimers();
    renderTags({ initial: ["Alpha", "Beta"] });
    fireEvent.change(input(), { target: { value: "beta" } });
    fireEvent.blur(input());
    expect(document.querySelector("[data-highlighted]")).toBeNull();
    expect(notice()).toHaveTextContent("Already in the list: Beta");
    fireEvent.keyDown(input(), { key: "Enter" });
    const lit = document.querySelector("[data-highlighted]");
    expect(lit).toHaveTextContent("Beta");
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(document.querySelector("[data-highlighted]")).toBeNull();
    // the notice outlives the highlight until the user does something else
    expect(notice()).toHaveTextContent("Already in the list: Beta");
  });

  it("writes the notice again when the same repeat is refused twice", async () => {
    renderTags({ initial: ["Alpha"] });
    fireEvent.change(input(), { target: { value: "alpha" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(notice()).toHaveTextContent("Already in the list: Alpha");
    fireEvent.keyDown(input(), { key: "Enter" });
    // emptied first so a screen reader reads it again, then written back
    expect(notice()).toHaveTextContent("");
    await waitFor(() => expect(notice()).toHaveTextContent("Already in the list: Alpha"));
  });

  it("does not bring a notice back when the user types during the re-announce gap", () => {
    vi.useFakeTimers();
    renderTags({ initial: ["Alpha"] });
    fireEvent.change(input(), { target: { value: "alpha" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(notice()).toHaveTextContent("");
    fireEvent.change(input(), { target: { value: "alphas" } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(notice()).toHaveTextContent("");
  });

  it("does not read the same notice again when the box is left with it already shown", () => {
    vi.useFakeTimers();
    renderTags({ initial: ["Alpha"] });
    fireEvent.change(input(), { target: { value: "alpha" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.blur(input());
    expect(notice()).toHaveTextContent("Already in the list: Alpha");
  });

  it("clears both timers on unmount: no state update afterwards", () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderTags({ initial: ["Alpha"] });
    fireEvent.change(input(), { target: { value: "alpha" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("restarts the highlight when the same repeat is refused again", () => {
    vi.useFakeTimers();
    renderTags({ initial: ["Alpha", "Beta"] });
    fireEvent.change(input(), { target: { value: "beta" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.keyDown(input(), { key: "Enter" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 2 s after the first refusal but only 1 s after the second
    expect(document.querySelector("[data-highlighted]")).toHaveTextContent("Beta");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(document.querySelector("[data-highlighted]")).toBeNull();
  });

  it("clears the notice when the user keeps typing", async () => {
    const user = userEvent.setup();
    renderTags({ initial: ["Alpha"] });
    await user.type(input(), "alpha{Enter}");
    expect(notice()).toHaveTextContent("Already in the list");
    await user.type(input(), "s");
    expect(notice()).toHaveTextContent("");
    expect(input()).toHaveValue("alphas");
  });

  it("clears the notice when the existing entry is removed", async () => {
    const user = userEvent.setup();
    renderTags({ initial: ["Alpha", "Beta"] });
    await user.type(input(), "alpha{Enter}");
    await user.click(screen.getByRole("button", { name: "Remove Alpha" }));
    expect(values()).toEqual(["Beta"]);
    expect(notice()).toHaveTextContent("");
  });

  it("keeps the focus and the text on blur and shows the notice without adding", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTags({ initial: ["Alpha"], onChange });
    await user.type(input(), "ALPHA");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(input()).toHaveValue("ALPHA");
    expect(notice()).toHaveTextContent("Already in the list: Alpha");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "elsewhere" }));
  });

  it("adds the entry once the repeat has been edited into something new", async () => {
    const user = userEvent.setup();
    renderTags({ initial: ["Alpha"] });
    await user.type(input(), "alpha{Enter}");
    await user.type(input(), " two{Enter}");
    expect(values()).toEqual(["Alpha", "alpha two"]);
    expect(input()).toHaveValue("");
    expect(notice()).toHaveTextContent("");
  });
});

describe("TagInput: dedupe modes", () => {
  it("exact: a regex differing only in case is a different entry, an identical one is refused", async () => {
    const user = userEvent.setup();
    renderTags({ dedupe: "exact", commitOnComma: false, initial: [String.raw`\d{1,3}`] });
    await user.type(input(), String.raw`\D{{1,3}` + "{Enter}");
    expect(values()).toEqual([String.raw`\d{1,3}`, String.raw`\D{1,3}`]);
    await user.type(input(), String.raw`\d{{1,3}` + "{Enter}");
    expect(values()).toHaveLength(2);
    expect(notice()).toHaveTextContent("Already in the list");
  });

  it("exact: a number list refuses a repeated number", async () => {
    const user = userEvent.setup();
    renderTags({ dedupe: "exact", initial: ["50", "80"] });
    await user.type(input(), "80{Enter}");
    expect(values()).toEqual(["50", "80"]);
    await user.type(input(), "{Control>}a{/Control}{Backspace}90{Enter}");
    expect(values()).toEqual(["50", "80", "90"]);
  });

  it("none: repeats are added", async () => {
    const user = userEvent.setup();
    renderTags({ dedupe: "none", initial: ["1"] });
    await user.type(input(), "1{Enter}");
    await user.type(input(), "1{Enter}");
    expect(values()).toEqual(["1", "1", "1"]);
    expect(notice()).toHaveTextContent("");
  });
});

describe("TagInput: input methods", () => {
  it("ignores Enter while composing and does not prevent it", () => {
    const onChange = vi.fn();
    renderTags({ onChange });
    fireEvent.change(input(), { target: { value: "ni" } });
    expect(fireEvent.keyDown(input(), { key: "Enter", isComposing: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(input()).toHaveValue("ni");
  });

  it("ignores keyCode 229 (Safari) for Enter and the comma", () => {
    const onChange = vi.fn();
    renderTags({ onChange });
    fireEvent.change(input(), { target: { value: "ni" } });
    expect(fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: ",", keyCode: 229 })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits normally on the Enter after the candidate was confirmed", () => {
    renderTags();
    fireEvent.change(input(), { target: { value: "你好" } });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(values()).toEqual([]);
    fireEvent.keyDown(input(), { key: "Enter", isComposing: false, keyCode: 13 });
    expect(values()).toEqual(["你好"]);
  });

  it("does not remove the last entry on Backspace while composing", () => {
    renderTags({ initial: ["Alpha"] });
    expect(fireEvent.keyDown(input(), { key: "Backspace", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: "Backspace", keyCode: 229 })).toBe(true);
    expect(values()).toEqual(["Alpha"]);
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(values()).toEqual([]);
  });
});
