import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { QueueHint } from "@/components/control/queue-hint";
import type { ControlQueueView } from "@/lib/control/request-view-schema";

import en from "../../messages/en.json";

const queue: ControlQueueView = {
  ahead: 2,
  running: null,
  startedAt: null,
  now: "2026-10-28T12:00:00.000Z",
  worker: { process: "ai-worker", online: true, heartbeatAgeSeconds: 3 },
};

const show = (live?: boolean) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <QueueHint queue={queue} stage="pending" {...(live === undefined ? {} : { live })} />
    </NextIntlClientProvider>,
  );

describe("QueueHint live region", () => {
  it("is a status region by default", () => {
    show();
    expect(screen.getByRole("status")).toHaveTextContent("2 requests ahead of it.");
  });

  it("is plain text, with the same lines, when a parent announces it", () => {
    show(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("queue-hint-ahead")).toHaveTextContent("2 requests ahead of it.");
  });
});
