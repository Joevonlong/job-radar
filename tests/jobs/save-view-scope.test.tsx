import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { expect, it, vi } from "vitest";

import { SaveViewButton } from "@/components/jobs/save-view-button";
import en from "../../messages/en.json";

vi.mock("@/app/interests/actions", () => ({ saveViewAction: vi.fn() }));

it.each(["current", "archive", "all"])("explains scope exclusion when saving from %s", async (scope) => {
  const Adapter = withNuqsTestingAdapter({ searchParams: `?scope=${scope}&q=engineer&reason=gone` });
  render(<Adapter><NextIntlClientProvider locale="en" messages={en}><SaveViewButton /></NextIntlClientProvider></Adapter>);
  await userEvent.click(screen.getByTestId("save-view"));
  if (scope === "current") expect(screen.queryByTestId("save-view-scope-hint")).toBeNull();
  else expect(screen.getByTestId("save-view-scope-hint")).toHaveTextContent(en.dashboard.jobs.scope.notSaved);
});

it.each(["country=DE", "searchIn=all", "country=DE&searchIn=all"])("explains why URL-only search settings cannot be saved: %s", (query) => {
  const Adapter = withNuqsTestingAdapter({ searchParams: `?${query}` });
  render(<Adapter><NextIntlClientProvider locale="en" messages={en}><SaveViewButton /></NextIntlClientProvider></Adapter>);
  const button = screen.getByTestId("save-view");
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", en.dashboard.jobs.filters.notSaved);
  expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")).toHaveTextContent(en.dashboard.jobs.filters.notSaved);
});

it("shows the search exclusions alongside the scope exclusion when filters can be saved", async () => {
  const Adapter = withNuqsTestingAdapter({ searchParams: "?q=engineer&country=DE&searchIn=all&scope=archive" });
  render(<Adapter><NextIntlClientProvider locale="en" messages={en}><SaveViewButton /></NextIntlClientProvider></Adapter>);
  await userEvent.click(screen.getByTestId("save-view"));
  expect(screen.getByTestId("save-view-search-hint")).toHaveTextContent(en.dashboard.jobs.filters.notSaved);
  expect(screen.getByTestId("save-view-scope-hint")).toBeInTheDocument();
});
