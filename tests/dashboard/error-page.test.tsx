import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { describe, expect, it, vi } from "vitest";

import ErrorPage from "@/app/error";
import { ConfigError } from "@/lib/config/errors";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

describe.each([{ locale: "en", messages: en }, { locale: "zh", messages: zh }] as const)("page errors in $locale", ({ locale, messages }) => {
  it("shows a serialized config error with a repair link and no private details", () => {
    const error = Object.assign(new Error("Server component error"), { digest: "job-radar:config:schedule" });
    render(<NextIntlClientProvider locale={locale} messages={messages}><ErrorPage error={error} retry={vi.fn()} /></NextIntlClientProvider>);
    expect(screen.getByRole("heading")).toHaveTextContent(messages.dashboard.error.configTitle);
    expect(screen.getByRole("alert")).toHaveTextContent("schedule.yaml");
    expect(screen.getByRole("link", { name: messages.dashboard.error.repair })).toHaveAttribute("href", "/settings?tab=advanced");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Server component error");
  });

  it("explains an outdated action and offers a full reload", () => {
    render(<NextIntlClientProvider locale={locale} messages={messages}><ErrorPage error={new UnrecognizedActionError("private action id")} retry={vi.fn()} /></NextIntlClientProvider>);
    expect(screen.getByRole("heading")).toHaveTextContent(messages.dashboard.error.updatedTitle);
    expect(screen.getByRole("button", { name: messages.dashboard.error.reload })).toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("private action id");
  });
});

it("puts only a config identifier into the digest that survives production error redaction", () => {
  const error = new ConfigError({ configName: "channels", filePath: "/private/config/sources.yaml", kind: "schema", detail: "private form value" });
  expect(error).toHaveProperty("digest", "job-radar:config:channels");
});
