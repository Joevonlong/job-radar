import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResumeChip } from "@/components/resume/resume-chip";
import { ResumePanel } from "@/components/resume/resume-panel";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const { exportResumeKitAction, attachResumePdfAction, detachResumePdfAction } = vi.hoisted(() => ({
  exportResumeKitAction: vi.fn(),
  attachResumePdfAction: vi.fn(),
  detachResumePdfAction: vi.fn(),
}));
vi.mock("@/app/jobs/[id]/resume-actions", () => ({ exportResumeKitAction, attachResumePdfAction, detachResumePdfAction }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

const COMMAND = 'cd /Users/me/resume-kit && claude "/tailor /data/jd/acme-ai-2026-10-07.md"';

beforeEach(() => {
  exportResumeKitAction.mockReset();
  attachResumePdfAction.mockReset();
  detachResumePdfAction.mockReset();
});

describe("ResumeChip", () => {
  it("shows the file name of the stored path, the full path as title", () => {
    render(wrap(<ResumeChip path="/Users/me/Exports/Acme_AI.pdf" />));
    const chip = screen.getByText("Resume: Acme_AI.pdf");
    expect(chip.closest("[data-slot='resume-chip']")).toHaveAttribute("title", "/Users/me/Exports/Acme_AI.pdf");
  });

  it("is localized", () => {
    render(wrap(<ResumeChip path="/x/Acme.pdf" />, "zh"));
    expect(screen.getByText("简历：Acme.pdf")).toBeInTheDocument();
  });
});

describe("ResumePanel", () => {
  it("exports, then shows the path and the command with a copy button", async () => {
    exportResumeKitAction.mockResolvedValue({ ok: true, jdPath: "/data/jd/acme-ai-2026-10-07.md", command: COMMAND, status: "preparing", statusChanged: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(wrap(<ResumePanel jobId={7} resumePath={null} pdfEnabled pdfs={[]} />));

    await userEvent.click(screen.getByTestId("resume-export"));
    expect(exportResumeKitAction).toHaveBeenCalledWith({ jobId: 7 });
    expect(await screen.findByTestId("resume-jd-path")).toHaveTextContent("/data/jd/acme-ai-2026-10-07.md");
    expect(screen.getByTestId("resume-command")).toHaveTextContent(COMMAND);
    expect(screen.getByTestId("resume-status-note")).toHaveTextContent("set to “Preparing”");

    await userEvent.click(screen.getByTestId("resume-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMAND));
    expect(screen.getByTestId("resume-copy")).toHaveTextContent("Copied");
  });

  it("tells where to configure the resume-kit folder when there is no command", async () => {
    exportResumeKitAction.mockResolvedValue({ ok: true, jdPath: "/data/jd/x.md", command: null, status: "preparing", statusChanged: false });
    render(wrap(<ResumePanel jobId={7} resumePath={null} pdfEnabled pdfs={[]} />));
    await userEvent.click(screen.getByTestId("resume-export"));
    expect(await screen.findByTestId("resume-no-kit")).toHaveTextContent("resume_kit_path");
    expect(screen.queryByTestId("resume-copy")).toBeNull();
    expect(screen.getByTestId("resume-status-note")).toHaveTextContent("already “Preparing”");
  });

  it("says when the application is further along and keeps its status", async () => {
    exportResumeKitAction.mockResolvedValue({ ok: true, jdPath: "/data/jd/x.md", command: COMMAND, status: "applied", statusChanged: false });
    render(wrap(<ResumePanel jobId={7} resumePath={null} pdfEnabled pdfs={[]} />));
    await userEvent.click(screen.getByTestId("resume-export"));
    expect(await screen.findByTestId("resume-status-note")).toHaveTextContent("stays “Applied”");
  });

  it("attaches the typed PDF and reports a rejected path", async () => {
    attachResumePdfAction.mockResolvedValueOnce({ ok: false, error: "outside" }).mockResolvedValueOnce({ ok: true, path: "/pdfs/Acme.pdf", name: "Acme.pdf" });
    render(wrap(<ResumePanel jobId={7} resumePath={null} pdfEnabled pdfs={["Acme.pdf", "Other.pdf"]} />));
    const input = screen.getByTestId("resume-pdf-input");
    expect(screen.getByTestId("resume-attach")).toBeDisabled();

    await userEvent.type(input, "../secret.pdf");
    await userEvent.click(screen.getByTestId("resume-attach"));
    expect(attachResumePdfAction).toHaveBeenLastCalledWith({ jobId: 7, path: "../secret.pdf" });
    expect(await screen.findByTestId("resume-attach-error")).toHaveTextContent("Only files inside pdf_dir");

    await userEvent.clear(input);
    await userEvent.type(input, "Acme.pdf");
    expect(screen.queryByTestId("resume-attach-error")).toBeNull();
    await userEvent.click(screen.getByTestId("resume-attach"));
    await waitFor(() => expect(attachResumePdfAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input).toHaveValue(""));
    // the picker offers the PDFs of the directory
    expect(document.querySelectorAll("#resume-pdf-options option")).toHaveLength(2);
  });

  it("shows the attached resume with a detach button", async () => {
    detachResumePdfAction.mockResolvedValue({ ok: true });
    render(wrap(<ResumePanel jobId={7} resumePath="/pdfs/Acme_AI.pdf" pdfEnabled pdfs={[]} />));
    expect(screen.getByTestId("resume-current")).toHaveTextContent("Resume: Acme_AI.pdf");
    await userEvent.click(screen.getByTestId("resume-detach"));
    expect(detachResumePdfAction).toHaveBeenCalledWith({ jobId: 7 });
  });

  it("explains how to switch attaching on when pdf_dir is not configured", () => {
    render(wrap(<ResumePanel jobId={7} resumePath={null} pdfEnabled={false} pdfs={[]} />));
    expect(screen.getByTestId("resume-no-pdf-dir")).toHaveTextContent("pdf_dir");
    expect(screen.queryByTestId("resume-pdf-input")).toBeNull();
  });
});
