// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configLayersCheck } from "@/lib/ops/doctor/checks/config";
import type { ConfigLayersState } from "@/lib/config";

import { configLayersState, makeContext, only } from "./helpers";

const check = (edit: Partial<ConfigLayersState> = {}) => only(configLayersCheck, makeContext({ probes: { configLayers: async () => configLayersState(edit) } }));

describe("config.layers", () => {
  it("is ok with a writable, current user directory and names both directories", async () => {
    const result = await check();
    expect(result).toMatchObject({ id: "config.layers", group: "data", status: "ok" });
    expect(result.detail).toBe("用户配置 data/config（10 个文件），默认配置 config");
  });

  it("fails when the user directory is missing or read-only, with the command that fixes it", async () => {
    const missing = await check({ userDirExists: false, userDirWritable: null });
    expect(missing.status).toBe("fail");
    expect(missing.hint).toContain("pnpm config:init");
    const readOnly = await check({ userDirWritable: false });
    expect(readOnly.status).toBe("fail");
    expect(readOnly.detail).toContain("不可写");
  });

  it("warns about overridden shipped files: product updates of them no longer apply", async () => {
    const result = await check({ overrides: ["models.yaml"] });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("你覆盖了 models.yaml：产品更新这些文件的内容不会生效");
    expect(result.hint).toContain("data/config");
  });

  it("warns about files behind the code and says to run config:migrate --write", async () => {
    const result = await check({ pendingMigrations: [{ file: "data/config/interests.yaml", from: 1, to: 2 }] });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("data/config/interests.yaml（版本 1 → 2）");
    expect(result.hint).toContain("pnpm config:migrate --write");
  });

  it("fails for a file newer than the code (a downgrade), warns for files not copied yet", async () => {
    const newer = await check({ problems: [{ file: "data/config/ui.yaml", message: "config_version 3 is newer …" }] });
    expect(newer.status).toBe("fail");
    expect(newer.hint).toContain(".backup");
    const notCopied = await check({ notCopied: ["ui.yaml"] });
    expect(notCopied.status).toBe("warn");
    expect(notCopied.hint).toContain("pnpm config:init");
  });
});
