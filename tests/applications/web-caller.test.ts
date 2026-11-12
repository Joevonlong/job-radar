import { expect, it, vi } from "vitest";

import { markAppliedAction, setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { saveNextActionAction, setInterviewRoundsAction } from "@/app/pipeline/actions";

const services = vi.hoisted(() => ({ changeApplicationStatus: vi.fn(), markApplied: vi.fn(), setNextAction: vi.fn(), setInterviewRounds: vi.fn() }));
vi.mock("@/lib/applications/service", () => services);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", async (original) => ({ ...await original<typeof import("@/lib/db")>(), getDb: () => ({}) }));

it("untrusted web payloads never choose an agent caller", async () => {
  services.changeApplicationStatus.mockResolvedValue({ ok: true, previous: "new", status: "applied", changed: true });
  services.markApplied.mockResolvedValue({ ok: true, previous: "new", status: "applied", changed: true });
  services.setNextAction.mockResolvedValue(true);
  services.setInterviewRounds.mockResolvedValue(3);
  const status = { jobId: 9, status: "applied", caller: "stdio" };
  const applied = { jobId: 9, caller: 12 };
  const next = { jobId: 9, nextAction: "Next", nextActionDate: null, caller: "stdio" };
  const rounds = { jobId: 9, rounds: 3, caller: 12 };
  await setApplicationStatusAction(status);
  await markAppliedAction(applied);
  await saveNextActionAction(next);
  await setInterviewRoundsAction(rounds);
  for (const service of Object.values(services)) {
    const args = service.mock.calls[0];
    expect(args[2]).toBeUndefined();
    expect(args[1]).not.toHaveProperty("caller");
  }
});
