import { beforeEach, describe, expect, it, vi } from "vitest";

const db = { name: "db" };
const auto = vi.hoisted(() => ({ triggerAutoResearch: vi.fn(async () => undefined), statusStartsResearch: vi.fn((status: string) => ["interested", "preparing", "applied"].includes(status)) }));
const repo = vi.hoisted(() => ({
  addFavorite: vi.fn(),
  jobExists: vi.fn(async () => true),
  setApplicationStatus: vi.fn(),
  removeFavorite: vi.fn(),
  setFavoriteNote: vi.fn(),
  restoreFavorite: vi.fn(),
  setApplicationNotes: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/research/auto", () => auto);
vi.mock("@/lib/db", async (original) => ({ ...(await original<typeof import("@/lib/db")>()), getDb: () => db, ...repo }));

const { setFavoriteAction, restoreFavoriteAction } = await import("@/app/favorites/actions");
const { setApplicationStatusAction, markAppliedAction } = await import("@/app/jobs/[id]/actions");

beforeEach(() => vi.clearAllMocks());

describe("what the buttons start", () => {
  it("a new star does, a repeated one does not", async () => {
    repo.addFavorite.mockResolvedValueOnce({ changed: true });
    await setFavoriteAction({ jobId: 7, favorite: true });
    expect(auto.triggerAutoResearch).toHaveBeenCalledWith(db, { jobId: 7, event: "favorite" });
    auto.triggerAutoResearch.mockClear();
    repo.addFavorite.mockResolvedValueOnce({ changed: false });
    await setFavoriteAction({ jobId: 7, favorite: true });
    expect(auto.triggerAutoResearch).not.toHaveBeenCalled();
  });

  it("the undo of an un-star does not", async () => {
    await restoreFavoriteAction({ jobId: 7, note: null, createdAt: "2026-11-01T10:00:00.000Z" });
    expect(auto.triggerAutoResearch).not.toHaveBeenCalled();
  });

  it("a status of working on an application does, when it changed", async () => {
    repo.setApplicationStatus.mockResolvedValueOnce({ previous: "new", status: "applied", changed: true });
    await setApplicationStatusAction({ jobId: 7, status: "applied" });
    expect(auto.triggerAutoResearch).toHaveBeenCalledWith(db, { jobId: 7, event: "status" });
    auto.triggerAutoResearch.mockClear();
    repo.setApplicationStatus.mockResolvedValueOnce({ previous: "applied", status: "applied", changed: false });
    await setApplicationStatusAction({ jobId: 7, status: "applied" });
    repo.setApplicationStatus.mockResolvedValueOnce({ previous: "applied", status: "rejected", changed: true });
    await setApplicationStatusAction({ jobId: 7, status: "rejected" });
    expect(auto.triggerAutoResearch).not.toHaveBeenCalled();
  });

  it("marking as applied does", async () => {
    repo.setApplicationStatus.mockResolvedValueOnce({ previous: "new", status: "applied", changed: true });
    await markAppliedAction({ jobId: 7 });
    expect(auto.triggerAutoResearch).toHaveBeenCalledWith(db, { jobId: 7, event: "status" });
  });
});
