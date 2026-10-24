import { beforeEach, describe, expect, it, vi } from "vitest";

import { addWatchedCompanyAction, removeWatchedCompaniesAction, removeWatchedCompanyAction } from "@/app/interests/actions";

const mocks = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), removeMany: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/interests/service", () => ({ addWatchedCompany: mocks.add, removeWatchedCompany: mocks.remove, removeWatchedCompanies: mocks.removeMany }));
vi.mock("@/lib/interests/preview", () => ({ previewCategory: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("company watch actions", () => {
  it.each(["add", "remove"] as const)("%s refreshes both Companies and Interests after a successful write", async (kind) => {
    const saved = { status: "saved", section: "watched", nonce: 1 } as const;
    mocks[kind].mockResolvedValue(saved);
    const action = kind === "add" ? addWatchedCompanyAction : removeWatchedCompanyAction;
    expect(await action({ name: "Acme GmbH" })).toBe(saved);
    expect(mocks[kind]).toHaveBeenCalledWith({ name: "Acme GmbH" });
    expect(mocks.revalidate).toHaveBeenCalledWith("/companies");
    expect(mocks.revalidate).toHaveBeenCalledWith("/interests");
  });

  it("does not refresh after a failed write", async () => {
    const failed = { status: "error", section: "watched", nonce: 1, formError: "writeFailed", fieldErrors: [] } as const;
    mocks.add.mockResolvedValue(failed);
    expect(await addWatchedCompanyAction({ name: "Acme" })).toBe(failed);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("refreshes every affected page after removing all matching entries", async () => {
    const saved = { status: "saved", section: "watched", nonce: 1 } as const;
    mocks.removeMany.mockResolvedValue(saved);
    const request = { names: ["Acme", "Acme GmbH"] };
    expect(await removeWatchedCompaniesAction(request)).toBe(saved);
    expect(mocks.removeMany).toHaveBeenCalledWith(request);
    expect(mocks.revalidate.mock.calls).toEqual([["/interests"], ["/"], ["/jobs"], ["/companies"]]);
  });

  it("does not refresh after a failed bulk removal", async () => {
    const failed = { status: "error", section: "watched", nonce: 1, formError: "watchedNotFound", fieldErrors: [] } as const;
    mocks.removeMany.mockResolvedValue(failed);
    expect(await removeWatchedCompaniesAction({ names: ["Acme"] })).toBe(failed);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
