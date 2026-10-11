import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BoardDialog } from "@/components/sources/registry/board-dialog";

import en from "../../messages/en.json";

const actions = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn() }));
vi.mock("@/app/sources/registry/actions", () => ({ saveAtsBoardAction: actions.save, removeAtsBoardAction: actions.remove }));

const dialog = () => (
  <NextIntlClientProvider locale="en" messages={en}>
    <BoardDialog open board={null} onOpenChange={() => {}} />
  </NextIntlClientProvider>
);

beforeEach(() => actions.save.mockReset());

describe("BoardDialog field errors", () => {
  it("drops the duplicate error as soon as the ATS or the token is edited", async () => {
    actions.save.mockResolvedValue({ status: "error", error: "invalid", fieldErrors: [{ path: "token", message: "duplicate ats + token" }] });
    const user = userEvent.setup();
    render(dialog());
    await user.type(screen.getByTestId("board-name"), "Zellwerk");
    await user.type(screen.getByTestId("board-token"), "zellwerk");
    await user.click(screen.getByTestId("board-save"));
    expect(await screen.findByTestId("board-error-token")).toHaveTextContent("already in the list");

    await user.type(screen.getByTestId("board-token"), "2");
    expect(screen.queryByTestId("board-error-token")).toBeNull();

    // the same again, this time by changing the ATS
    await user.click(screen.getByTestId("board-save"));
    await waitFor(() => expect(screen.getByTestId("board-error-token")).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId("board-ats"), "ashby");
    expect(screen.queryByTestId("board-error-token")).toBeNull();
  });

  it("keeps an error of a field that was not edited", async () => {
    actions.save.mockResolvedValue({ status: "error", error: "invalid", fieldErrors: [{ path: "name", message: "must not be empty" }] });
    const user = userEvent.setup();
    render(dialog());
    await user.type(screen.getByTestId("board-token"), "x");
    await user.click(screen.getByTestId("board-save"));
    expect(await screen.findByTestId("board-error-name")).toBeInTheDocument();
    await user.type(screen.getByTestId("board-token"), "y");
    expect(screen.getByTestId("board-error-name")).toBeInTheDocument();
  });
});
