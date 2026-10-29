import { NextIntlClientProvider } from "next-intl";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { StatusBadge } from "@/components/activity-log/shared";
import { EventParams } from "@/components/activity-log/event-params";

describe("activity presentation", () => {
  it("translates the attempt and current request status independently", () => {
    render(<NextIntlClientProvider locale="zh" messages={zh}><StatusBadge value={{ code: "interrupted", requestCurrent: "done", possiblyInterrupted: false }} /></NextIntlClientProvider>);
    expect(screen.getByText("已中断")).toBeVisible();
    expect(screen.getByText("请求当前状态：已完成")).toBeVisible();
  });
  it("translates callback values, counters, cascade reasons and links covered cycles", () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <EventParams event={{ code: "item.ok", params: { action: "interested", result: "changed", count: 5, error_code: "unknown_private_code", unit: "SECRET_PAYLOAD" } }} />
      <EventParams event={{ code: "cascade_reasons", params: { fixture: "budget_exceeded" } }} />
      <EventParams event={{ code: "covered_by", params: { cycle_id: 7 } }} />
    </NextIntlClientProvider>);
    expect(container).toHaveTextContent("Action: Interested");
    expect(container).toHaveTextContent("Result: Changed");
    expect(container).toHaveTextContent("fixture: Budget exceeded");
    expect(container).toHaveTextContent("Other error");
    expect(container).not.toHaveTextContent("SECRET_PAYLOAD");
    expect(screen.getByRole("link", { name: "Covered by cycle #7" })).toHaveAttribute("href", "/sources/logs?cycle=7");
  });
  it("renders the fixed parse failure message", () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}><EventParams event={{ code: "parse_failed", params: { parse_error: "SECRET_PAYLOAD" } }} /></NextIntlClientProvider>);
    expect(container).toHaveTextContent("Raw posting could not be parsed");
    expect(container).not.toHaveTextContent("SECRET_PAYLOAD");
  });
});
