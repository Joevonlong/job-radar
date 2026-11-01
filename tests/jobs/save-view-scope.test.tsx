import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { expect, it, vi } from "vitest";

import { saveViewAction } from "@/app/interests/actions";
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

it.each(["?within=7d&dateBy=posted", "?within=month", "?from=2026-10-01&dateBy=posted", "?from=2026-10-01&to=2026-10-15&dateBy=seen"])("saves a date condition as the only filter: %s", (query) => {
  const Adapter = withNuqsTestingAdapter({ searchParams: query });
  render(<Adapter><NextIntlClientProvider locale="en" messages={en}><SaveViewButton /></NextIntlClientProvider></Adapter>);
  expect(screen.getByTestId("save-view")).toBeEnabled();
});

it.each(["?within=7d&dateBy=posted&city=Berlin", "?from=2026-10-01&dateBy=posted&city=Berlin", "?city=Berlin"])("has no hint about unsaved dates: %s", async (query) => {
  const Adapter = withNuqsTestingAdapter({ searchParams: query });
  render(<Adapter><NextIntlClientProvider locale="en" messages={en}><SaveViewButton /></NextIntlClientProvider></Adapter>);
  await userEvent.click(screen.getByTestId("save-view"));
  expect(screen.queryByTestId("save-view-date-hint")).toBeNull();
});

it("saves the quick range with what it compares", async () => {
  const save = vi.mocked(saveViewAction);
  save.mockResolvedValue({ status: "saved", section: "views", nonce: 1 });
  const Adapter = withNuqsTestingAdapter({ searchParams: "?within=7d&dateBy=posted&city=Berlin" });
  render(<Adapter><NextIntlClientProvider locale="en" messages={en}><SaveViewButton /></NextIntlClientProvider></Adapter>);
  await userEvent.click(screen.getByTestId("save-view"));
  await userEvent.type(screen.getByTestId("save-view-name"), "Fresh");
  await userEvent.click(screen.getByTestId("save-view-submit"));
  expect(save).toHaveBeenCalledWith({ name: "Fresh", filters: { city: "Berlin", within: "7d", dateBy: "posted" }, overwrite: false, makeDefault: false });
});

it("keeps the plain 'set a filter first' tip when only dateBy is set", () => {
  const Adapter = withNuqsTestingAdapter({ searchParams: "?dateBy=posted&sort=posted" });
  render(<Adapter><NextIntlClientProvider locale="en" messages={en}><SaveViewButton /></NextIntlClientProvider></Adapter>);
  const button = screen.getByTestId("save-view");
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", en.interests.saveView.needFilters);
});
