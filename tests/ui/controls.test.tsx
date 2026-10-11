import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Badge, CountBadge, SignalTag, badgeVariants } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("is role=switch and toggles aria-checked", async () => {
    render(<Switch aria-label="Notify" />);
    const toggle = screen.getByRole("switch", { name: "Notify" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("does not toggle when disabled", async () => {
    render(<Switch aria-label="Notify" disabled />);
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
});

describe("Checkbox and RadioGroup", () => {
  it("checkbox toggles and supports the mixed state", async () => {
    const { rerender } = render(<Checkbox aria-label="Remote" />);
    const box = screen.getByRole("checkbox", { name: "Remote" });
    await userEvent.click(box);
    expect(box).toBeChecked();
    rerender(<Checkbox aria-label="Remote" checked="indeterminate" />);
    expect(screen.getByRole("checkbox", { name: "Remote" })).toHaveAttribute("aria-checked", "mixed");
  });

  it("radio group selects one option and the arrow keys move", async () => {
    render(
      <RadioGroup aria-label="Level" defaultValue="b2">
        <RadioGroupItem value="b1" aria-label="B1" />
        <RadioGroupItem value="b2" aria-label="B2" />
        <RadioGroupItem value="c1" aria-label="C1" />
      </RadioGroup>,
    );
    expect(screen.getByRole("radio", { name: "B2" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "B2" }));
    await userEvent.keyboard("{ArrowDown>}");
    await waitFor(() => expect(screen.getByRole("radio", { name: "C1" })).toBeChecked());
    await userEvent.keyboard("{/ArrowDown}");
  });
});

describe("Input", () => {
  it("plain input stays a single input element with the md size", () => {
    render(<Input aria-label="Name" />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAttribute("data-slot", "input");
    expect(input.className).toContain("h-ctl-md");
    expect(input.parentElement?.getAttribute("data-slot")).not.toBe("input-group");
  });

  it.each([
    ["sm", "h-ctl-sm"],
    ["lg", "h-ctl-lg"],
  ] as const)("size %s", (size, cls) => {
    render(<Input aria-label="Name" size={size} />);
    expect(screen.getByRole("textbox").className).toContain(cls);
  });

  it("renders prefix and suffix inside the box and keeps aria-invalid on the input", () => {
    render(<Input aria-label="Salary" prefix="€" suffix="/年" aria-invalid="true" />);
    const input = screen.getByRole("textbox", { name: "Salary" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("€")).toBeInTheDocument();
    expect(screen.getByText("/年")).toBeInTheDocument();
    expect(input.closest('[data-slot="input-group"]')).toHaveAttribute("data-invalid");
  });

  it("supports disabled and read-only", () => {
    render(
      <>
        <Input aria-label="Off" disabled />
        <Input aria-label="Ro" readOnly defaultValue="x" />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Off" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Ro" })).toHaveAttribute("readonly");
  });
});

describe("Badge", () => {
  it("keeps the legacy variants and has the v3 base variants", () => {
    for (const variant of ["default", "secondary", "destructive", "outline", "ghost", "link"] as const) {
      expect(badgeVariants({ variant })).toContain("border-bw");
    }
    expect(badgeVariants({ variant: "gate-bad" })).toContain("bg-bad");
    expect(badgeVariants({ variant: "skill-miss" })).toContain("border-dashed");
    expect(badgeVariants({ variant: "gate-out" })).toContain("line-through");
    render(<Badge variant="signal-t2">T2</Badge>);
    expect(screen.getByText("T2")).toHaveAttribute("data-variant", "signal-t2");
  });

  it("CountBadge caps at 99+", () => {
    render(<CountBadge value={120} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("SignalTag shows the category code (or else its icon, or else only the colour) and the name", () => {
    const { rerender, container } = render(
      <SignalTag code="T2" icon="📈" color="teal">
        股权
      </SignalTag>,
    );
    expect(screen.getByText("T2")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("股权")).toBeInTheDocument();
    expect(container.querySelector("[data-slot=signal-tag] b")?.className).toContain("bg-signal-t2");
    rerender(
      <SignalTag code={null} icon="🛂" color="violet">
        Visa
      </SignalTag>,
    );
    expect(screen.getByText("🛂")).toBeInTheDocument();
    rerender(
      <SignalTag code={null} color="pink">
        Perks
      </SignalTag>,
    );
    expect(container.querySelector("[data-slot=signal-tag] b")?.textContent).toBe("");
    expect(container.querySelector("[data-slot=signal-tag] b")?.className).toContain("bg-signal-pink");
  });
});
