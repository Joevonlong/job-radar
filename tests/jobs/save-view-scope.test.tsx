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
