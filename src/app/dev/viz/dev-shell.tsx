"use client";

import { useTheme } from "next-themes";
import { useState, type ReactNode } from "react";

/** Page frame of the dev page: title and the paper / terminal switch (the app's own next-themes theme). */
export function DevShell({ children }: { children: ReactNode }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  // next-themes only knows the stored theme in the browser: the buttons may differ from the server render until then.
  const current = resolvedTheme ?? theme ?? "light";
  return (
    <div data-theme={current} suppressHydrationWarning>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", marginBottom: "var(--space-6)", flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-h1)", lineHeight: "var(--text-h1-lh)", margin: 0 }}>Viz library</h1>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-data)", color: "var(--ink-3)" }}>/dev/viz · dev only</span>
        <div role="group" aria-label="Theme" style={{ marginLeft: "auto", display: "flex", border: "var(--bw) solid var(--ink)", borderRadius: "var(--r-btn)", overflow: "hidden", boxShadow: "var(--e2)" }}>
          {(["light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={current === value}
              data-theme-button={value}
              suppressHydrationWarning
              onClick={() => setTheme(value)}
              style={{
                padding: "var(--space-1) var(--space-3)",
                fontFamily: "var(--font-sans)",
                fontWeight: 700,
                fontSize: "var(--text-label)",
                border: 0,
                cursor: "pointer",
                background: current === value ? "var(--ink)" : "var(--card-bg)",
                color: current === value ? "var(--bg)" : "var(--ink)",
              }}
            >
              {value === "light" ? "Paper (light)" : "Terminal (dark)"}
            </button>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

/** A titled card; its body is re-mounted by the replay button, which plays every animation in it again. */
export function ShowCard({ title, aux, children }: { title: string; aux?: string; children: ReactNode }) {
  const [epoch, setEpoch] = useState(0);
  return (
    <section
      aria-label={title}
      style={{
        background: "var(--card-bg)",
        border: "var(--bw) solid var(--ink)",
        borderRadius: "var(--r-card)",
        boxShadow: "var(--e3)",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-4)", borderBottom: "var(--bw) solid var(--ink)", background: "var(--soft)", borderRadius: "var(--r-card) var(--r-card) 0 0" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-h2)", lineHeight: "var(--text-h2-lh)", margin: 0 }}>{title}</h2>
        {aux ? <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-data-sm)", color: "var(--ink-3)" }}>{aux}</span> : null}
        <button
          type="button"
          onClick={() => setEpoch((value) => value + 1)}
          style={{ marginLeft: "auto", flex: "none", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "var(--text-data-sm)", fontWeight: 600, background: "var(--card-bg)", color: "var(--ink)", border: "var(--bw) solid var(--ink)", borderRadius: "var(--r-tag)", padding: "0 var(--space-2)", cursor: "pointer" }}
        >
          Replay
        </button>
      </header>
      <div key={epoch} style={{ padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-4)", minWidth: 0 }}>
        {children}
      </div>
    </section>
  );
}

/** One labelled sample inside a card: the state name on the left, the component below it. */
export function Sample({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", minWidth: 0, alignItems: wide ? "stretch" : "flex-start" }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-cap)", lineHeight: "var(--text-cap-lh)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  );
}

export function Row({ children, gap = "var(--space-4)" }: { children: ReactNode; gap?: string }) {
  return <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap }}>{children}</div>;
}
