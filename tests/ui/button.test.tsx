import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

describe("buttonVariants", () => {
  it.each([
    ["primary", "bg-hi"],
    ["ink", "bg-ink"],
    ["default", "bg-card"],
    ["ghost", "bg-transparent"],
    ["danger", "bg-bad"],
    ["link", "underline"],
  ] as const)("variant %s carries %s", (variant, cls) => {
    expect(buttonVariants({ variant })).toContain(cls);
  });

  it.each([
    ["sm", "h-ctl-sm"],
    ["md", "h-ctl-md"],
    ["lg", "h-ctl-lg"],
    ["icon", "size-ctl-md"],
  ] as const)("size %s carries %s", (size, cls) => {
    expect(buttonVariants({ size })).toContain(cls);
  });

  it("keeps the legacy names working", () => {
    expect(buttonVariants({ variant: "outline" })).toContain("bg-card");
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-card");
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-bad");
    expect(buttonVariants({ size: "default" })).toContain("h-ctl-md");
    expect(buttonVariants({ size: "icon-sm" })).toContain("size-ctl-sm");
  });

  it("uses the press gesture and the token shadows", () => {
    const classes = buttonVariants({ variant: "primary" });
    expect(classes).toContain("press");
    expect(classes).toContain("shadow-e2");
    expect(buttonVariants({ size: "lg" })).toContain("shadow-e3");
  });

  it("lifts on hover: shadowed variants rise and grow the shadow one step, flat ones do not", () => {
    for (const variant of ["primary", "ink", "default", "danger", "outline", "secondary", "destructive"] as const) {
      const classes = buttonVariants({ variant });
      expect(classes, variant).toMatch(/(^| )lift( |$)/);
      expect(classes, variant).toContain("[--lift-shadow:var(--e3)]");
    }
    for (const variant of ["ghost", "link"] as const) expect(buttonVariants({ variant }), variant).not.toMatch(/(^| )lift( |$)/);
    // one step up from the resting shadow of each size
    // (cn() is what Button applies: the later size class replaces the variant's)
    expect(cn(buttonVariants({ variant: "primary", size: "lg" }))).toContain("[--lift-shadow:var(--e4)]");
    expect(cn(buttonVariants({ variant: "primary", size: "lg" }))).not.toContain("[--lift-shadow:var(--e3)]");
    expect(cn(buttonVariants({ variant: "default", size: "xs" }))).toContain("[--lift-shadow:var(--e2)]");
  });
});

describe("Button", () => {
  it("renders md default and exposes variant and size as data attributes", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("data-variant", "default");
    expect(button).toHaveAttribute("data-size", "md");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).toBeEnabled();
  });

  it("loading disables the button, sets aria-busy and shows a spinner next to the caller's label", () => {
    render(
      <Button loading variant="primary">
        Saving…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector('[data-slot="button-spinner"]')).not.toBeNull();
  });

  it("does not call onClick while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving…
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("holds the idle width as a floor while loading and releases it afterwards", () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({ width: 120 }) as DOMRect;
    try {
      const { rerender } = render(<Button>Save</Button>);
      const button = screen.getByRole("button");
      expect(button.style.minWidth).toBe("");
      rerender(<Button loading>Saving…</Button>);
      expect(button.style.minWidth).toBe("120px");
      rerender(<Button>Save</Button>);
      expect(button.style.minWidth).toBe("");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("renders a key hint and announces it as a shortcut", () => {
    render(<Button kbd="N">New</Button>);
    const button = screen.getByRole("button", { name: /New/ });
    expect(button).toHaveAttribute("aria-keyshortcuts", "N");
    expect(button.querySelector("kbd")).toHaveTextContent("N");
  });

  it("toggle buttons keep aria-pressed", () => {
    render(<Button aria-pressed="true">Starred</Button>);
    expect(screen.getByRole("button", { name: "Starred" })).toHaveAttribute("aria-pressed", "true");
  });

  it("asChild styles a link and marks it disabled and busy without a disabled attribute", () => {
    render(
      <Button asChild loading variant="primary">
        <a href="/x">Open</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).not.toHaveAttribute("disabled");
  });
});

describe("lift utility (globals.css)", () => {
  const css = readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");
  const lift = css.slice(css.indexOf("@utility lift"), css.indexOf("@utility press"));

  it("skips disabled, busy and pressed buttons", () => {
    expect(lift).toContain(':hover:not(:active, :disabled, [aria-disabled="true"], [aria-busy="true"], [aria-pressed="true"])');
    expect(lift).toContain("box-shadow: var(--lift-shadow)");
  });

  it("moves the box only when motion is allowed, by a token", () => {
    const motion = lift.slice(lift.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(motion).toContain("translate:");
    expect(motion).toContain("var(--lift-d)");
    expect(lift.slice(0, lift.indexOf("@media"))).not.toContain("translate:");
    expect(css).toMatch(/--lift-d: \d+px/);
  });

  it("leaves :active to press, so the collapse always wins over the lift", () => {
    expect(lift).toContain(":hover:not(:active,");
  });
});
