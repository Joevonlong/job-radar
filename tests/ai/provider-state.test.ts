import { describe, expect, it } from "vitest";

import { aiProviderState, type AiProviderStateInput } from "@/lib/ai/provider-state";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 8, 10, minutes));
const base: AiProviderStateInput = { configured: true, enabled: true, coolingUntil: null, dailyCap: 0, requestsToday: 0, lastErrorKind: null, lastErrorAt: null, lastSuccessAt: null };

describe("aiProviderState", () => {
  it("is ready by default", () => {
    expect(aiProviderState(base)).toBe("ready");
  });

  it("orders the reasons: not configured, switched off, cooling, capped, not logged in", () => {
    expect(aiProviderState({ ...base, configured: false, enabled: false })).toBe("unconfigured");
    expect(aiProviderState({ ...base, enabled: false, coolingUntil: at(30) })).toBe("off");
    expect(aiProviderState({ ...base, coolingUntil: at(30), dailyCap: 1, requestsToday: 1 })).toBe("cooling");
    expect(aiProviderState({ ...base, dailyCap: 5, requestsToday: 5 })).toBe("capped");
    expect(aiProviderState({ ...base, dailyCap: 5, requestsToday: 4 })).toBe("ready");
  });

  it("reads a login error as 'not logged in' until a later success, and a missing CLI as not configured", () => {
    expect(aiProviderState({ ...base, lastErrorKind: "auth", lastErrorAt: at(10) })).toBe("auth");
    expect(aiProviderState({ ...base, lastErrorKind: "auth", lastErrorAt: at(10), lastSuccessAt: at(5) })).toBe("auth");
    expect(aiProviderState({ ...base, lastErrorKind: "auth", lastErrorAt: at(10), lastSuccessAt: at(20) })).toBe("ready");
    expect(aiProviderState({ ...base, lastErrorKind: "not_configured", lastErrorAt: at(10) })).toBe("unconfigured");
    expect(aiProviderState({ ...base, lastErrorKind: "timeout", lastErrorAt: at(10) })).toBe("ready");
  });
});

describe("aiProviderState: usage cap", () => {
  it("is guarded while Job Radar's usage cap holds it back, before cooling and the daily cap, after off", () => {
    expect(aiProviderState({ ...base, guardedUntil: at(30) })).toBe("guarded");
    expect(aiProviderState({ ...base, guardedUntil: at(30), coolingUntil: at(40), dailyCap: 1, requestsToday: 1 })).toBe("guarded");
    expect(aiProviderState({ ...base, enabled: false, guardedUntil: at(30) })).toBe("off");
    expect(aiProviderState({ ...base, guardedUntil: null })).toBe("ready");
  });
});
