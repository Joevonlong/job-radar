import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { CareerEditor } from "@/components/career/career-editor";
import { CareerStatus } from "@/components/career/career-status";
import { careerSchema } from "@/lib/config/schemas/career";
import { formatFullTime } from "@/lib/format/time";

const codes = [
  "profile_invalid",
  "stale",
  "unknown_id",
  "history_invalid",
  "version_missing",
  "write_failed",
  "contact_invalid",
  "disabled",
  "confirmation_required",
  "request_failed",
  "limits",
  "history_failed",
];

describe.each([
  { locale: "en", messages: en },
  { locale: "zh", messages: zh },
] as const)("career feedback in $locale", ({ locale, messages }) => {
  it.each(codes)("shows readable feedback for %s and keeps the code in an attribute", (code) => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <CareerStatus code={code} />
      </NextIntlClientProvider>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-code", code);
    expect(status.textContent).not.toContain(code);
    expect(status.textContent!.length).toBeGreaterThan(0);
  });

  it("falls back to a generic message for unknown codes", () => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <CareerStatus code="unexpected_failure" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(messages.career.errors.generic);
    expect(screen.getByRole("status")).toHaveAttribute("data-code", "unexpected_failure");
    expect(screen.getByRole("status").textContent).not.toContain("unexpected_failure");
  });

  it("keeps career descriptions clear of existing save-status selectors", () => {
    for (const description of [
      messages.settings.tabDescription.career,
      messages.career.description,
      messages.career.notCreated,
    ]) {
      expect(description).not.toMatch(/已保存|保存|Saved/i);
    }
  });

  it("uses the supplied display zone for history and complete, distinct deletion dialogs", () => {
    const timeZone = "Asia/Tokyo";
    const createdAt = "2026-01-01T00:00:00Z";
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <CareerEditor
          initial={null}
          contact={null}
          initialVersions={[{ id: "version", createdAt, hash: "12345678" }]}
          errors={["history_invalid"]}
          limits={careerSchema.parse({}).profile}
          timeZone={timeZone}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(formatFullTime(createdAt, { locale, timeZone }))).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(messages.career.errors.historyInvalid);
    expect(screen.getByRole("alert")).toHaveAttribute("data-code", "history_invalid");
    fireEvent.click(screen.getByRole("button", { name: messages.career.clearHistory }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(messages.career.clearHistoryTitle);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(messages.career.clearHistoryDescription);
    fireEvent.click(screen.getByRole("button", { name: messages.career.cancel }));
    fireEvent.click(screen.getByRole("button", { name: messages.career.deleteProfile }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(messages.career.deleteProfileTitle);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(messages.career.deleteProfileDescription);
  });
});
