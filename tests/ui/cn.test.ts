import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn with design-system v3 utilities", () => {
  it("keeps a v3 text size next to a v3 text colour", () => {
    expect(cn("text-label text-ink-2")).toBe("text-label text-ink-2");
    expect(cn("text-h1 text-hi-ink")).toBe("text-h1 text-hi-ink");
  });

  it("lets a later size or colour win inside its own group", () => {
    expect(cn("text-label", "text-title")).toBe("text-title");
    expect(cn("text-ink", "text-ink-2")).toBe("text-ink-2");
    expect(cn("text-sm", "text-body")).toBe("text-body");
  });

  it("treats border-bw as a width and border-border as a colour", () => {
    expect(cn("border-bw border-border")).toBe("border-bw border-border");
    expect(cn("border-bw", "border-2")).toBe("border-2");
    expect(cn("border-b-bw border-border")).toBe("border-b-bw border-border");
    expect(cn("border-l-bw border-border first:border-l-0")).toBe("border-l-bw border-border first:border-l-0");
    expect(cn("border-bw", "border-b-0")).toBe("border-bw border-b-0");
  });

  it("merges heights, shadows, radii and layers", () => {
    expect(cn("h-ctl-md", "h-ctl-sm")).toBe("h-ctl-sm");
    expect(cn("h-9", "h-ctl-lg")).toBe("h-ctl-lg");
    expect(cn("shadow-e2", "shadow-e4")).toBe("shadow-e4");
    expect(cn("shadow-e2", "shadow-none")).toBe("shadow-none");
    expect(cn("rounded-card", "rounded-btn")).toBe("rounded-btn");
    expect(cn("z-modal", "z-toast")).toBe("z-toast");
    expect(cn("duration-base", "duration-slow")).toBe("duration-slow");
  });
});
