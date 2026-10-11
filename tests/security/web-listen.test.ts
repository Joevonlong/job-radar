// @vitest-environment node
import { describe, expect, it } from "vitest";

import { localExemptionEnabled } from "@/lib/security/local-request";
import { planWebListen } from "@/lib/security/web-listen";

describe("planWebListen (pnpm start / pnpm dev)", () => {
  it("JOB_RADAR_WEB_BIND set: Next listens there, and the web is told so", () => {
    expect(planWebListen(["-p", "3000"], "127.0.0.1")).toEqual({ args: ["-p", "3000", "-H", "127.0.0.1"], bind: "127.0.0.1" });
    expect(planWebListen([], " [::1] ")).toEqual({ args: ["-H", "::1"], bind: "::1" });
    expect(planWebListen([], "192.168.1.20")).toEqual({ args: ["-H", "192.168.1.20"], bind: "192.168.1.20" });
  });

  it("an explicit -H / --hostname wins over the variable, and becomes the bind the web is told", () => {
    expect(planWebListen(["-p", "3100", "-H", "127.0.0.1"], undefined)).toEqual({ args: ["-p", "3100", "-H", "127.0.0.1"], bind: "127.0.0.1" });
    expect(planWebListen(["--hostname", "0.0.0.0"], "127.0.0.1").bind).toBe("0.0.0.0");
    expect(planWebListen(["--hostname=0.0.0.0"], "127.0.0.1").bind).toBe("0.0.0.0");
    expect(planWebListen(["-H0.0.0.0"], "127.0.0.1").bind).toBe("0.0.0.0");
  });

  it("an IPv6 hostname in brackets reaches Next without them, once", () => {
    expect(planWebListen(["-p", "3000", "-H", "[::1]"], undefined)).toEqual({ args: ["-p", "3000", "-H", "::1"], bind: "::1" });
    expect(planWebListen(["--hostname=[::1]", "-p", "3000"], "0.0.0.0")).toEqual({ args: ["-p", "3000", "-H", "::1"], bind: "::1" });
    expect(planWebListen(["-H", ""], "127.0.0.1")).toEqual({ args: [], bind: "0.0.0.0" });
  });

  it("neither: Next listens on every interface, so the web is told 0.0.0.0 and nobody skips the login", () => {
    const plan = planWebListen(["-p", "3000"], undefined);
    expect(plan).toEqual({ args: ["-p", "3000"], bind: "0.0.0.0" });
    expect(localExemptionEnabled({ JOB_RADAR_WEB_BIND: plan.bind })).toBe(false);
    expect(planWebListen([], "   ").bind).toBe("0.0.0.0");
  });

  it("a loopback bind keeps the exemption on", () => {
    expect(localExemptionEnabled({ JOB_RADAR_WEB_BIND: planWebListen([], "127.0.0.1").bind })).toBe(true);
    expect(localExemptionEnabled({ JOB_RADAR_WEB_BIND: planWebListen(["-H", "localhost"], undefined).bind })).toBe(true);
  });
});
