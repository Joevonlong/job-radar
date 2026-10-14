// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** deploy_final_rc <config_writes_pending> <doctor_rc> (scripts/ops/lib/deploy-result.sh): the whole table. */
const lib = path.resolve(import.meta.dirname, "../../scripts/ops/lib/deploy-result.sh");
const finalRc = (pending: string, doctor: string): string =>
  spawnSync("bash", ["-c", `source "$1"; deploy_final_rc "$2" "$3"`, "_", lib, pending, doctor], { encoding: "utf8" }).stdout.trim();

describe("deploy_final_rc", () => {
  it.each([
    ["0", "0", "0"],
    ["0", "1", "0"],
    ["0", "2", "2"],
    ["0", "127", "1"],
    ["1", "0", "2"],
    ["1", "1", "2"],
    ["1", "2", "2"],
    ["1", "127", "2"],
  ])("pending %s, doctor %s -> %s", (pending, doctor, expected) => {
    expect(finalRc(pending, doctor)).toBe(expected);
  });
});
