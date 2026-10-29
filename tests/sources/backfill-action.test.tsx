import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BackfillAction } from "@/components/sources/backfill-action";
import type { ControlRequestView } from "@/lib/control/request-view-schema";
import type { BackfillOptions } from "@/lib/sources/backfill";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const actions = vi.hoisted(() => ({ backfillAction: vi.fn(), runChannelNowAction: vi.fn(), testChannelAction: vi.fn(), testAiAction: vi.fn(), testTelegramAction: vi.fn() }));
vi.mock("@/app/control-actions", () => actions);
const options: BackfillOptions = { maxHours: 168, channelIds: ["linkedin-apify", "linkedin-guest"], cascade: true, local: { paidChannels: ["linkedin-apify"], jsearch: false }, all: { paidChannels: ["linkedin-apify", "linkedin-monid"], jsearch: true } };
const view: ControlRequestView = { id: 7, kind: "run_cycle", status: "pending", requestedAt: "2026-10-29T10:00:00Z", startedAt: null, finishedAt: null, result: {}, cycle: null, queue: null };
beforeEach(() => {
  actions.backfillAction.mockReset().mockResolvedValue({ status: "queued", request: 7, kind: "run_cycle", existing: false, nonce: 1 });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => view })));
});
afterEach(() => vi.unstubAllGlobals());
const show = (over: Partial<BackfillOptions> = {}, locale: "en" | "zh" = "en") => render(<NextIntlClientProvider locale={locale} messages={{ en, zh }[locale]}><BackfillAction id="backfill-test" options={{ ...options, ...over }} /></NextIntlClientProvider>);

it.each([[36, ["12", "24"]], [6, ["6"]]])("offers only ranges within %s hours", async (maxHours, values) => {
  show({ maxHours: Number(maxHours) });
  await userEvent.setup().click(screen.getByRole("button", { name: "Backfill…" }));
  expect(Array.from(screen.getByLabelText("Look back").querySelectorAll("option"), (option) => option.value)).toEqual(values);
});
it("changes the cost preview and queues the chosen scope", async () => {
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole("button", { name: "Backfill…" }));
  expect(screen.getByTestId("backfill-cost")).toHaveTextContent("linkedin-apify");
  expect(screen.getByTestId("backfill-cost")).not.toHaveTextContent("linkedin-monid");
  await user.selectOptions(screen.getByLabelText("Look back"), "48");
  await user.selectOptions(screen.getByLabelText("Scope"), "all");
  expect(screen.getByTestId("backfill-cost")).toHaveTextContent("linkedin-monid");
  expect(screen.getByText(/JSearch stays within/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Queue backfill" }));
  await waitFor(() => expect(actions.backfillAction).toHaveBeenCalledExactlyOnceWith({ backfillHours: 48 }));
  expect(screen.getByTestId("trigger-outcome")).toHaveAttribute("data-outcome", "pending");
});
it("queues all cascade ids for this cascade", async () => {
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole("button", { name: "Backfill…" }));
  await user.selectOptions(screen.getByLabelText("Look back"), "48");
  await user.click(screen.getByRole("button", { name: "Queue backfill" }));
  await waitFor(() => expect(actions.backfillAction).toHaveBeenCalledExactlyOnceWith({ backfillHours: 48, channelIds: options.channelIds }));
});
it.each(["cycleBusy", "backfillOverLimit"] as const)("renders refusal %s", async (error) => {
  actions.backfillAction.mockResolvedValue({ status: "error", error, maxBackfillHours: 24, nonce: 1 });
  show();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Backfill…" }));
  await user.click(screen.getByRole("button", { name: "Queue backfill" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(error === "cycleBusy" ? en.trigger.refused.cycleBusy : "maximum (24 h)"));
});
it("uses the shared finished-request error with the new cap", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...view, status: "failed", result: { error: "backfill_over_limit", maxBackfillHours: 12 } }) })));
  show();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Backfill…" }));
  await user.click(screen.getByRole("button", { name: "Queue backfill" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("maximum 12 h"));
});
it("supports keyboard opening, collapse and Chinese labels without losing the panel", async () => {
  show({ local: { paidChannels: [], jsearch: false } }, "zh");
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("补抓范围")).toBeVisible();
  expect(screen.getByTestId("backfill-cost")).toHaveTextContent(zh.sources.backfill.noPaid);
  await user.click(screen.getByRole("button", { name: "补抓…" }));
  expect(screen.getByLabelText("补抓范围")).not.toBeVisible();
});
