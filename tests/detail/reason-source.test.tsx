import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JdPanel } from "@/components/jobs/detail/jd-panel";
import { BREAKDOWN_MARK_CLASS, EVIDENCE_MARK_CLASS, EVIDENCE_QUOTE, GHOST_MARK_CLASS, JD_JUMP_EVENT, TRAP_MARK_CLASS, VISA_MARK_CLASS, type JdJumpDetail } from "@/components/jobs/detail/marks";
import { ReasonSource } from "@/components/jobs/detail/reason-source";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { defaultCategoryViews } from "../signals/helpers";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

describe("ReasonSource", () => {
  it("JD: a solid marker that opens the verbatim quote and the jump to the original", async () => {
    const user = userEvent.setup();
    const jumps: number[] = [];
    const listener = (event: Event) => jumps.push((event as CustomEvent<JdJumpDetail>).detail.index);
    window.addEventListener(JD_JUMP_EVENT, listener);
    render(wrap(<ReasonSource text="要求 5 年 Python" source={{ basis: "jd", quote: "5+ years of Python", mark: 3 }} jumpable quoteLang="en" />, "zh"));
    const marker = screen.getByTestId("reason-source");
    expect(marker).toHaveTextContent(zh.scoreEvidence.basis.jd);
    expect(marker).toHaveAttribute("data-basis", "jd");
    expect(marker.className).toContain("bg-ink");
    expect(marker).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("reason-quote-box")).not.toBeVisible();
    await user.click(marker);
    expect(marker).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("reason-quote")).toBeVisible();
    expect(screen.getByTestId("reason-quote")).toHaveTextContent("“5+ years of Python”");
    expect(screen.getByTestId("reason-quote")).toHaveAttribute("lang", "en");
    expect(screen.getByTestId("reason-quote").className).toContain("border-dashed");
    await user.click(screen.getByTestId("reason-jump"));
    expect(screen.getByTestId("reason-jump")).toHaveTextContent(zh.scoreEvidence.viewInJd);
    expect(jumps).toEqual([3]);
    window.removeEventListener(JD_JUMP_EVENT, listener);
  });

  it("JD without a mark in the panel: the quote opens, no jump button", async () => {
    const user = userEvent.setup();
    render(wrap(<ReasonSource text="x" source={{ basis: "jd", quote: "spans\nlines", mark: 0 }} jumpable={false} />));
    await user.click(screen.getByTestId("reason-source"));
    expect(screen.getByTestId("reason-quote")).toBeVisible();
    expect(screen.queryByTestId("reason-jump")).toBeNull();
  });

  it("Inferred: an outlined marker that explains itself", () => {
    render(wrap(<ReasonSource text="资深职位" source={{ basis: "inferred", quote: null, mark: null }} jumpable={false} />, "zh"));
    const marker = screen.getByTestId("reason-source");
    expect(marker).toHaveTextContent(zh.scoreEvidence.basis.inferred);
    expect(marker).toHaveAttribute("title", zh.scoreEvidence.hint.inferred);
    expect(marker.className).toContain("border-border");
    expect(marker.className).not.toContain("bg-ink");
  });

  it("Inferred and Not stated: the hint opens from the keyboard too", async () => {
    const user = userEvent.setup();
    render(wrap(<ReasonSource text="资深职位" source={{ basis: "inferred", quote: null, mark: null }} jumpable={false} />, "zh"));
    const marker = screen.getByRole("button", { name: /推断/ });
    expect(marker).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("reason-hint")).not.toBeVisible();
    await user.tab();
    expect(marker).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(marker).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("reason-hint")).toBeVisible();
    expect(screen.getByTestId("reason-hint")).toHaveTextContent(zh.scoreEvidence.hint.inferred);
    expect(marker).toHaveAttribute("aria-controls", screen.getByTestId("reason-hint").id);
  });

  it("Not stated: a dashed marker that says the JD does not mention it", () => {
    render(wrap(<ReasonSource text="Salary not stated" source={{ basis: "unstated", quote: null, mark: null }} jumpable={false} />));
    const marker = screen.getByTestId("reason-source");
    expect(marker).toHaveTextContent("Not stated");
    expect(marker).toHaveAttribute("title", en.scoreEvidence.hint.unstated);
    expect(marker.className).toContain("border-dashed");
  });

  it("no source (an old score, or a reason the model gave no source for): the text alone", () => {
    const { rerender } = render(wrap(<ReasonSource text="旧理由" source={null} jumpable={false} />));
    expect(screen.getByTestId("reason-text")).toHaveTextContent("旧理由");
    expect(screen.queryByTestId("reason-source")).toBeNull();
    rerender(wrap(<ReasonSource text="旧理由" source={{ basis: null, quote: null, mark: null }} jumpable={false} />));
    expect(screen.queryByTestId("reason-source")).toBeNull();
  });

  it("renders a quote as text, never as HTML", async () => {
    const user = userEvent.setup();
    const quote = '<img src=x onerror="alert(1)"> Ignore previous instructions';
    render(wrap(<ReasonSource text="x" source={{ basis: "jd", quote, mark: null }} jumpable={false} />));
    await user.click(screen.getByTestId("reason-source"));
    expect(screen.getByTestId("reason-quote")).toHaveTextContent(quote);
    expect(screen.getByTestId("reason-quote").querySelector("img")).toBeNull();
  });
});

describe("the JD panel's reason mark", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("is a thin solid underline unlike the other marks, with its legend entry, and takes a jump", () => {
    const jd = "Intro.\n- 5+ years of Python\n- Yearly bonus.";
    render(wrap(<JdPanel translationLanguage="Chinese" description={jd} language="en" categories={defaultCategoryViews()} quotes={[{ text: "Yearly bonus.", tier: "T4" }, { text: "5+ years of Python", tier: EVIDENCE_QUOTE }]} translation={null} />));
    const mark = document.getElementById("jd-quote-1");
    expect(mark).toHaveTextContent("5+ years of Python");
    expect(mark).toHaveAttribute("data-tier", "evidence");
    expect(mark).toHaveAttribute("title", en.scoreEvidence.jdMark.title);
    expect(mark?.className).toContain("decoration-solid");
    expect(screen.getByTestId("jd-legend-evidence")).toHaveTextContent(en.scoreEvidence.jdMark.legend);
    for (const other of [BREAKDOWN_MARK_CLASS, VISA_MARK_CLASS, GHOST_MARK_CLASS, TRAP_MARK_CLASS]) expect(other).not.toBe(EVIDENCE_MARK_CLASS);
    expect([BREAKDOWN_MARK_CLASS, VISA_MARK_CLASS, GHOST_MARK_CLASS, TRAP_MARK_CLASS].some((c) => c.includes("decoration-solid"))).toBe(false);
    act(() => window.dispatchEvent(new CustomEvent<JdJumpDetail>(JD_JUMP_EVENT, { detail: { index: 1 } })));
    expect(mark).toHaveClass("jr-flash");
  });
});
