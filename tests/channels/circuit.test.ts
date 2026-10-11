// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  afterFailure,
  afterSuccess,
  CircuitBreaker,
  CLOSED_CIRCUIT,
  effectiveState,
  healthOf,
  isCallAllowed,
  type CircuitConfig,
} from "@/lib/channels/circuit";
import { createMemoryStateStore } from "@/lib/channels/store";

const CONFIG: CircuitConfig = { failures: 3, cooldownMs: 24 * 3_600_000 };
const T0 = new Date("2026-10-07T07:00:00Z");
const at = (hours: number): Date => new Date(T0.getTime() + hours * 3_600_000);

describe("circuit transitions", () => {
  it("stays closed below the failure threshold", () => {
    let s = afterFailure(CLOSED_CIRCUIT, T0, "network", CONFIG);
    s = afterFailure(s, T0, "network", CONFIG);
    expect(s).toMatchObject({ state: "closed", consecutiveFailures: 2, lastErrorCode: "network" });
    expect(isCallAllowed(s, T0)).toBe(true);
  });

  it("opens after N consecutive failures and blocks until the cooldown ends", () => {
    let s = CLOSED_CIRCUIT;
    for (let i = 0; i < 3; i += 1) s = afterFailure(s, T0, "rate_limited", CONFIG);
    expect(s.state).toBe("open");
    expect(s.openUntil).toEqual(at(24));
    expect(isCallAllowed(s, at(0))).toBe(false);
    expect(isCallAllowed(s, at(23.99))).toBe(false);
    expect(effectiveState(s, at(23.99))).toBe("open");
  });

  it("becomes half-open once the cooldown has passed, allowing one probe", () => {
    let s = CLOSED_CIRCUIT;
    for (let i = 0; i < 3; i += 1) s = afterFailure(s, T0, "blocked", CONFIG);
    expect(effectiveState(s, at(24))).toBe("half_open");
    expect(isCallAllowed(s, at(24))).toBe(true);
    expect(isCallAllowed(s, at(100))).toBe(true);
  });

  it("closes on a successful probe and clears the streak", () => {
    let s = CLOSED_CIRCUIT;
    for (let i = 0; i < 3; i += 1) s = afterFailure(s, T0, "blocked", CONFIG);
    s = afterSuccess(s, at(25));
    expect(s).toMatchObject({ state: "closed", consecutiveFailures: 0, openUntil: null, lastSuccessAt: at(25) });
    expect(healthOf(s, at(25))).toBe("healthy");
  });

  it("reopens immediately, with a fresh cooldown, when the probe fails", () => {
    let s = CLOSED_CIRCUIT;
    for (let i = 0; i < 3; i += 1) s = afterFailure(s, T0, "blocked", CONFIG);
    const probeFailed = afterFailure(s, at(25), "blocked", CONFIG);
    expect(probeFailed.state).toBe("open");
    expect(probeFailed.openUntil).toEqual(at(49));
    expect(isCallAllowed(probeFailed, at(26))).toBe(false);
  });

  it("a failure that trips the circuit opens it at once, below the threshold (a used-up provider quota)", () => {
    const s = afterFailure(CLOSED_CIRCUIT, T0, "rate_limited", CONFIG, { trips: true });
    expect(s).toMatchObject({ state: "open", consecutiveFailures: 1, lastErrorCode: "rate_limited" });
    expect(s.openUntil).toEqual(at(24));
    expect(isCallAllowed(s, T0)).toBe(false);
    // without the flag one failure changes nothing about the state
    expect(afterFailure(CLOSED_CIRCUIT, T0, "rate_limited", CONFIG).state).toBe("closed");
  });

  it("a success in between resets the streak (failures must be consecutive)", () => {
    let s = afterFailure(CLOSED_CIRCUIT, T0, "network", CONFIG);
    s = afterFailure(s, T0, "network", CONFIG);
    s = afterSuccess(s, T0);
    s = afterFailure(s, T0, "network", CONFIG);
    s = afterFailure(s, T0, "network", CONFIG);
    expect(s.state).toBe("closed");
    expect(afterFailure(s, T0, "network", CONFIG).state).toBe("open");
  });

  it("derives channel health", () => {
    expect(healthOf(CLOSED_CIRCUIT, T0)).toBe("unknown");
    expect(healthOf(afterFailure(CLOSED_CIRCUIT, T0, "network", CONFIG), T0)).toBe("degraded");
    let open = CLOSED_CIRCUIT;
    for (let i = 0; i < 3; i += 1) open = afterFailure(open, T0, "network", CONFIG);
    expect(healthOf(open, T0)).toBe("down");
    expect(healthOf(open, at(30))).toBe("down"); // half-open still counts as down until a probe succeeds
  });
});

describe("CircuitBreaker with a fake clock", () => {
  function setup() {
    let now = T0;
    const store = createMemoryStateStore();
    const breaker = new CircuitBreaker(store, () => CONFIG, () => now);
    return { breaker, store, advance: (hours: number) => (now = at(hours)) };
  }

  it("opens, cools down, probes and closes", async () => {
    const { breaker, store, advance } = setup();
    expect((await breaker.check("c")).allowed).toBe(true);
    for (let i = 0; i < 3; i += 1) await breaker.recordFailure("c", "network");
    expect(await breaker.check("c")).toMatchObject({ allowed: false, state: "open" });
    expect((await store.loadCircuit("c")).state).toBe("open");

    advance(24);
    expect(await breaker.check("c")).toMatchObject({ allowed: true, state: "half_open" });
    expect((await store.loadCircuit("c")).state).toBe("half_open"); // persisted for the /sources page

    await breaker.recordSuccess("c");
    expect(await breaker.check("c")).toMatchObject({ allowed: true, state: "closed" });
    expect(await store.loadCircuit("c")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("a failed probe reopens the circuit for another cooldown", async () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i += 1) await breaker.recordFailure("c", "blocked");
    advance(24);
    await breaker.check("c");
    await breaker.recordFailure("c", "blocked");
    expect(await breaker.check("c")).toMatchObject({ allowed: false, state: "open" });
    advance(47);
    expect((await breaker.check("c")).allowed).toBe(false);
    advance(48);
    expect((await breaker.check("c")).allowed).toBe(true);
  });

  it("recordFailure with trips opens the persisted circuit on the first failure", async () => {
    const { breaker, store } = setup();
    await breaker.recordFailure("c", "rate_limited", { trips: true });
    expect(await breaker.check("c")).toMatchObject({ allowed: false, state: "open" });
    expect(await store.loadCircuit("c")).toMatchObject({ state: "open", consecutiveFailures: 1, lastErrorCode: "rate_limited" });
  });

  it("tracks channels independently", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i += 1) await breaker.recordFailure("a", "network");
    expect((await breaker.check("a")).allowed).toBe(false);
    expect((await breaker.check("b")).allowed).toBe(true);
  });

  it("loads persisted state of an earlier process", async () => {
    const store = createMemoryStateStore();
    await store.saveCircuit(
      "c",
      { state: "open", consecutiveFailures: 3, openUntil: at(5), lastErrorCode: "blocked", lastSuccessAt: null },
      "down",
    );
    const breaker = new CircuitBreaker(store, () => CONFIG, () => at(1));
    expect(await breaker.check("c")).toMatchObject({ allowed: false, state: "open" });
  });
});
