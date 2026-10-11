"use client";

import { useState } from "react";

import { NumberRoll } from "@/components/viz/number-roll";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";

const BUTTON = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-data)",
  fontWeight: 700,
  background: "var(--card-bg)",
  color: "var(--ink)",
  border: "var(--bw) solid var(--ink)",
  borderRadius: "var(--r-btn)",
  boxShadow: "var(--e2)",
  padding: "var(--space-1) var(--space-3)",
  cursor: "pointer",
} as const;

/** Buttons that change the values: only the digits that change roll. */
export function RollDemo() {
  const [count, setCount] = useState(1284);
  const [pct, setPct] = useState(41.4);
  const [range, setRange] = useState("7");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)", alignItems: "flex-end" }}>
        <span style={{ fontFamily: "var(--font-display)", fontSize: "var(--num-xl)", lineHeight: "var(--num-xl-lh)" }} data-demo="count">
          <NumberRoll value={count} />
        </span>
        <span style={{ fontFamily: "var(--font-display)", fontSize: "var(--num-l)", lineHeight: 1 }} data-demo="percent">
          <NumberRoll value={pct} format="percent" />
        </span>
        <span style={{ fontFamily: "var(--font-display)", fontSize: "var(--num-m)", lineHeight: 1 }}>
          <NumberRoll value={95000} format={{ style: "currency", currency: "EUR", maximumFractionDigits: 0 }} />
        </span>
        <span style={{ fontFamily: "var(--font-display)", fontSize: "var(--num-m)", lineHeight: 1 }} data-demo="unknown">
          <NumberRoll value={null} />
        </span>
      </div>
      <Segmented aria-label="Range" value={range} onValueChange={setRange}>
        <SegmentedItem value="7">7 d</SegmentedItem>
        <SegmentedItem value="30">30 d</SegmentedItem>
        <SegmentedItem value="90" count={3}>
          90 d
        </SegmentedItem>
      </Segmented>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        <button type="button" style={BUTTON} onClick={() => setCount((value) => value + 1)}>
          +1
        </button>
        <button type="button" style={BUTTON} onClick={() => setCount((value) => value + 100)}>
          +100
        </button>
        <button type="button" style={BUTTON} onClick={() => setCount((value) => Math.max(0, value - 7))}>
          −7
        </button>
        <button type="button" style={BUTTON} onClick={() => setCount(Math.round(Math.random() * 99999))}>
          random
        </button>
        <button type="button" style={BUTTON} onClick={() => setPct((value) => (value >= 10 ? 4.2 : 87))}>
          percent 4.2 / 87
        </button>
        <button type="button" style={BUTTON} onClick={() => setPct(0.04)}>
          percent &lt;0.1
        </button>
      </div>
    </div>
  );
}
