/** How the settings form hands each tag / number-list field to the tag box (repeats, commas). */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { FieldControl, type Translator } from "@/components/settings/field-control";
import { configToDraft, type DraftValue } from "@/lib/settings/draft";
import { fieldsOf, type FieldDef } from "@/lib/settings/fields";
import type { SettingsForm } from "@/lib/settings/tabs";

import en from "../../messages/en.json";
import { shippedConfig } from "./helpers";

function def(form: SettingsForm, path: string): FieldDef {
  const found = fieldsOf(form).find((field) => field.path === path);
  if (!found) throw new Error(`no field ${path} in ${form}`);
  return found;
}

function Control({ form, path, initial }: { form: SettingsForm; path: string; initial: string[] }) {
  const t: Translator = useTranslations("settings");
  const [value, setValue] = useState<DraftValue>(initial);
  return (
    <>
      <FieldControl def={def(form, path)} id="f" value={value} error={undefined} onChange={setValue} t={t} draft={configToDraft(form, shippedConfig(form))} catalog={undefined} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

function renderControl(form: SettingsForm, path: string, initial: string[]) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <Control form={form} path={path} initial={initial} />
    </NextIntlClientProvider>,
  );
}

const current = () => JSON.parse(screen.getByTestId("value").textContent ?? "null") as unknown;

describe("settings tag fields", () => {
  it("adds a scoring criterion with commas as one sentence", async () => {
    const user = userEvent.setup();
    renderControl("ai", "scoring.criteria.priorities", []);
    await user.type(screen.getByRole("textbox"), "Remote, or Berlin, with a small team{Enter}");
    expect(current()).toEqual(["Remote, or Berlin, with a small team"]);
  });

  it("still splits an ordinary tag field at a comma", async () => {
    const user = userEvent.setup();
    renderControl("insights", "cities", []);
    await user.type(screen.getByRole("textbox"), "Berlin,");
    expect(current()).toEqual(["Berlin"]);
  });

  it("refuses a repeated tag in an ordinary tag field, ignoring case", async () => {
    const user = userEvent.setup();
    renderControl("insights", "cities", ["Berlin"]);
    await user.type(screen.getByRole("textbox"), "berlin{Enter}");
    expect(current()).toEqual(["Berlin"]);
    expect(screen.getByTestId("tag-duplicate")).toHaveTextContent("Already in the list: Berlin");
  });

  it("allows a repeated number in the seniority distance table", async () => {
    const user = userEvent.setup();
    renderControl("ai", "scoring.priority.seniority_distance_fit", ["1"]);
    await user.type(screen.getByRole("textbox"), "1{Enter}");
    expect(current()).toEqual(["1", "1"]);
  });

  it.each([
    ["insights", "ranges_days"],
    ["notify", "alerts.budget_thresholds"],
  ] as const)("refuses a repeated number in %s %s", async (form, path) => {
    const user = userEvent.setup();
    renderControl(form, path, ["7"]);
    await user.type(screen.getByRole("textbox"), "7{Enter}");
    expect(current()).toEqual(["7"]);
    await user.type(screen.getByRole("textbox"), "{Backspace}30{Enter}");
    expect(current()).toEqual(["7", "30"]);
  });
});
