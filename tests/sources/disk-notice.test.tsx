import { render, screen } from "@testing-library/react";
import { createFormatter, createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import zh from "../../messages/zh.json";

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "zh", messages: zh as never, namespace: namespace as never }),
  getFormatter: async () => createFormatter({ locale: "zh" }),
}));

import { DiskNotice } from "@/components/sources/disk-notice";
import type { DiskStatus } from "@/lib/ops/disk";

const base: DiskStatus = { level: "warn", freeGb: 14, totalGb: 450, percent: 3, minGb: 5, warnGb: 20, source: "host", path: "/Users/me" };

describe("DiskNotice", () => {
  it("says the figure comes from the host ai-worker", async () => {
    render(await DiskNotice({ disk: base }));
    const notice = screen.getByTestId("disk-notice");
    expect(notice.getAttribute("data-source")).toBe("host");
    expect(notice.textContent).toContain("宿主机 ai-worker");
    expect(notice.textContent).toContain("/Users/me");
  });

  it("says when it is only the container's own measurement", async () => {
    render(await DiskNotice({ disk: { ...base, level: "fail", source: "local", path: null } }));
    const notice = screen.getByTestId("disk-notice");
    expect(notice.getAttribute("data-source")).toBe("local");
    expect(notice.textContent).toContain("容器内的测量");
  });

  it("renders nothing while there is enough space", async () => {
    expect(await DiskNotice({ disk: { ...base, level: "ok" } })).toBeNull();
  });
});
