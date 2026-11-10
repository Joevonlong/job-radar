// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";
import { SendPreview } from "@/components/outbound/send-preview";
import { editedPreview, type PreparedText } from "@/lib/outbound/preview";
import en from "../../messages/en.json";

const preview: PreparedText = { ok: true, text: "[name]\n[email]\nNationality: fictional", candidates: { name: "Fictional Person", address: null }, removed: 2, chars: 37, truncated: true, highlights: [{ start: 15, end: 37, kind: "sensitive" }] };

it("focuses the editable preview, shows evidence highlights and sends exactly the edited text", () => {
  const send = vi.fn();
  function Host() {
    const [value, update] = useState(preview);
    return <SendPreview preview={value} busy={false} onChange={update} onPrepare={vi.fn()} onSend={send} onCancel={vi.fn()} />;
  }
  render(<NextIntlClientProvider locale="en" messages={en}><Host /></NextIntlClientProvider>);
  expect(screen.getByTestId("outbound-text")).toHaveFocus();
  expect(screen.getByText(en.outbound.truncated)).toBeVisible();
  expect(screen.getByTestId("outbound-highlights").querySelector("mark")).toBeTruthy();
  fireEvent.change(screen.getByTestId("outbound-text"), { target: { value: "Corrected 2020-03\n[email]" } });
  fireEvent.click(screen.getByTestId("outbound-send"));
  expect(send).toHaveBeenCalledWith("Corrected 2020-03\n[email]");
});
it("requires applying optional values and passes only the current edited text to values mode", async () => {
  const prepare = vi.fn(async () => true);
  render(<NextIntlClientProvider locale="en" messages={en}><SendPreview preview={preview} busy={false} onChange={vi.fn()} onPrepare={prepare} onSend={vi.fn()} onCancel={vi.fn()} /></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.outbound.address), { target: { value: "00 Fictional Road" } });
  expect(screen.getByTestId("outbound-send")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: en.outbound.apply }));
  await waitFor(() => expect(screen.getByTestId("outbound-send")).not.toBeDisabled());
  expect(prepare).toHaveBeenCalledWith({ text: preview.text, name: "Fictional Person", address: "00 Fictional Road", mode: "values" });
});
it("shifts unaffected spans and drops highlights intersecting an edit", () => {
  const value = { ...preview, text: "abc sensitive end", highlights: [{ start: 4, end: 13, kind: "sensitive" }] };
  expect(editedPreview(value, "prefix abc sensitive end").highlights).toEqual([{ start: 11, end: 20, kind: "sensitive" }]);
  expect(editedPreview(value, "abc changed end").highlights).toEqual([]);
});
