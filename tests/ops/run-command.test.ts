// @vitest-environment node
import { describe, expect, it } from "vitest";

import { runCommand } from "@/lib/ops/doctor/probes";

describe.skipIf(process.platform === "win32")("runCommand options", () => {
  it("detached: the child leads a process group of its own (a terminal Ctrl-C does not reach it)", async () => {
    const out = await runCommand("sh", ["-c", "echo $$ $(ps -o pgid= -p $$)"], 5000, { detached: true });
    expect(out.kind).toBe("ran");
    const [pid, pgid] = out.kind === "ran" ? out.stdout.trim().split(/\s+/) : [];
    expect(pgid).toBe(pid);
    const attached = await runCommand("sh", ["-c", "echo $$ $(ps -o pgid= -p $$)"], 5000);
    const [pid2, pgid2] = attached.kind === "ran" ? attached.stdout.trim().split(/\s+/) : [];
    expect(pgid2).not.toBe(pid2);
  });

  it("env: the child sees exactly the environment given", async () => {
    const out = await runCommand("sh", ["-c", 'echo "${ONLY_HERE-unset} ${TELEGRAM_BOT_TOKEN-unset}"'], 5000, { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin", ONLY_HERE: "yes" } });
    expect(out.kind === "ran" ? out.stdout.trim() : "").toBe("yes unset");
  });
});
