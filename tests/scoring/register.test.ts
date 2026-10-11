// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { listAiSubtasks, resetAiSubtasks } from "@/lib/ai/step";
import { registerBuiltinAiSubtasks, registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { resetCycleSteps } from "@/lib/cycle/steps";

afterEach(() => {
  resetAiSubtasks();
  resetCycleSteps();
});

describe("AI sub-task registration", () => {
  it("registering the cycle steps does not register AI sub-tasks, so a whole-cycle test never reaches a real provider", () => {
    registerBuiltinCycleSteps();
    expect(listAiSubtasks()).toEqual([]);
  });

  it("the runner / cycle:run registration adds the AI sub-tasks in order (traps, score, signals, translate, breakdown), once", () => {
    registerBuiltinAiSubtasks();
    registerBuiltinAiSubtasks();
    expect(listAiSubtasks().map((s) => s.name)).toEqual(["traps", "score", "signals", "translate", "breakdown"]);
  });
});
