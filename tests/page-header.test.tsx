import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "@/components/shell/page-header";

describe("PageHeader", () => {
  it("renders the title as h1 and the description", () => {
    render(<PageHeader title="今日" description="本轮新岗位" />);
    expect(screen.getByRole("heading", { level: 1, name: "今日" })).toBeInTheDocument();
    expect(screen.getByText("本轮新岗位")).toBeInTheDocument();
  });

  it("sets the title in the display h1 size and the subtitle in mono data size", () => {
    render(<PageHeader title="岗位" description="2026-10-08" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("font-display", "text-h1");
    expect(screen.getByText("2026-10-08")).toHaveClass("font-mono", "text-data");
  });

  it("renders the right-hand action slot only when given", () => {
    const { container, rerender } = render(<PageHeader title="今日" description="d" />);
    expect(container.querySelector('[data-slot="page-header-actions"]')).toBeNull();
    rerender(<PageHeader title="今日" description="d" actions={<button type="button">添加</button>} />);
    expect(container.querySelector('[data-slot="page-header-actions"]')).toContainElement(screen.getByRole("button", { name: "添加" }));
  });

  it("keeps rendering children under the header row (existing callers)", () => {
    render(
      <PageHeader title="申请" description="d">
        <p data-testid="extra">summary</p>
      </PageHeader>,
    );
    expect(screen.getByTestId("extra")).toHaveTextContent("summary");
  });
});
