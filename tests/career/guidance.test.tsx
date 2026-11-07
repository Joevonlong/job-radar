import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { expect, it } from "vitest";
import { CareerGuidance } from "@/components/career/career-guidance";
import { emptyProfile, hasCareerContent } from "@/lib/career/schema/profile";
import { text } from "./fixtures";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

it.each([["en", en], ["zh", zh]] as const)("shows mandatory steps when empty and client-only collapse once populated (%s)", (locale, messages) => {
  const show = (empty: boolean) => <NextIntlClientProvider locale={locale} messages={messages}><CareerGuidance empty={empty} /></NextIntlClientProvider>;
  const { rerender, unmount } = render(show(true));
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText(messages.career.guidance.purpose)).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
  rerender(show(false));
  fireEvent.click(screen.getByRole("button", { name: messages.career.guidance.collapse }));
  expect(screen.queryByTestId("career-guidance-content")).toBeNull();
  rerender(show(true));
  expect(screen.getByTestId("career-guidance-steps")).toBeVisible();
  rerender(show(false));
  fireEvent.click(screen.getByRole("button", { name: messages.career.guidance.expand }));
  expect(screen.getByTestId("career-guidance-content")).toBeVisible();
  unmount();
  render(show(false));
  expect(screen.getByTestId("career-guidance-content")).toBeVisible();
});

it("counts a headline or summary as content even without entries", () => {
  expect(hasCareerContent(emptyProfile())).toBe(false);
  expect(hasCareerContent({ ...emptyProfile(), summary: text("A professional summary") })).toBe(true);
  expect(hasCareerContent({ ...emptyProfile(), headline: text("Engineer") })).toBe(true);
});
