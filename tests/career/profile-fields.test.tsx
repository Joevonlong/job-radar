import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { expect, it, vi } from "vitest";

vi.mock("@/app/career/actions", () => ({ saveProfileAction: vi.fn() }));
import { saveProfileAction } from "@/app/career/actions";
import { ProfileForm } from "@/components/career/profile-form";
import messages from "../../messages/en.json";
import {
  ObjectFields,
  changeCustomItemKind,
  sectionFields,
  type DataObject,
} from "@/components/career/profile-fields";
import { TextEditor } from "@/components/career/text-editor";
import { careerSchema } from "@/lib/config/schemas/career";
import { assignIds } from "@/lib/career/schema/ids";
import { careerProfileSchema, emptyProfile, type Text } from "@/lib/career/schema/profile";
import { profile } from "./fixtures";

it("clears optional facts to null after entering a URL or date", () => {
  let current = profile().experience[0]!;
  function Form() {
    const [value, setValue] = useState(current);
    return (
      <ObjectFields
        value={value as unknown as DataObject}
        fields={sectionFields.experience}
        limits={careerSchema.parse({}).profile}
        onChange={(next) => {
          current = next as unknown as typeof current;
          setValue(current);
        }}
      />
    );
  }
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Form />
    </NextIntlClientProvider>,
  );
  for (const [label, value] of [
    ["URL", "https://example.invalid"],
    [/Start date/, "2021-03"],
    [/End date/, "present"],
  ] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
  }
  expect(current.url).toBeNull();
  expect(current.start).toBeNull();
  expect(current.end).toBeNull();
  expect(careerProfileSchema.safeParse({ ...emptyProfile(), experience: [current] }).success).toBe(true);
});

it("adds a wording, sets it primary, removes a non-primary and respects the configured maximum", () => {
  const saved = assignIds(profile(), emptyProfile());
  let current = saved.experience[0]!.role;
  function Editor() {
    const [value, setValue] = useState<Text>(current);
    return (
      <TextEditor
        value={value}
        maxWordings={2}
        maxChars={100}
        onChange={(next) => {
          current = next;
          setValue(next);
        }}
      />
    );
  }
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Editor />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Another wording" }));
  expect(screen.getByRole("button", { name: "Another wording" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Wording 2"), { target: { value: "Platform Engineer" } });
  fireEvent.click(screen.getByRole("button", { name: "Set primary" }));
  expect(current.wordings[0]!.text).toBe("Platform Engineer");
  expect(screen.getAllByRole("button", { name: "Delete wording" })[0]).toBeDisabled();
  fireEvent.click(screen.getAllByRole("button", { name: "Delete wording" })[1]!);
  expect(current.wordings).toHaveLength(1);
  const next = assignIds({ ...saved, experience: [{ ...saved.experience[0]!, role: current }] }, saved);
  expect(next.experience[0]!.role.primary).toBe(next.experience[0]!.role.wordings[0]!.id);
});

it("keeps profile edits and shows a human-readable error if the action transport rejects", async () => {
  vi.mocked(saveProfileAction).mockRejectedValueOnce(new Error("private failure detail"));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProfileForm
        profile={profile()}
        baseHash={null}
        limits={careerSchema.parse({}).profile}
        onSaved={vi.fn()}
        onDirty={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Edited company" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  const error = await screen.findByText("The request could not be completed. Try again.");
  expect(error).toBeVisible();
  expect(error).toHaveAttribute("data-code", "request_failed");
  expect(error.textContent).not.toContain("request_failed");
  expect(screen.getByLabelText("Company")).toHaveValue("Edited company");
  expect(screen.queryByText("private failure detail")).toBeNull();
});

it("keeps a custom item's text and wordings when its kind changes", () => {
  const body = assignIds(profile("First wording"), emptyProfile()).experience[0]!.bullets[0]!;
  body.wordings.push({ ...body.wordings[0]!, id: "", text: "Second wording" });
  const textItem: DataObject = { id: "itm_aaaaaaaaaa", kind: "text", text: body };
  const bullet = changeCustomItemKind(textItem, "bullet");
  expect(bullet).toEqual({ id: "itm_aaaaaaaaaa", kind: "bullet", text: body });
  const entry = changeCustomItemKind(bullet, "entry");
  expect(entry).toMatchObject({ id: "itm_aaaaaaaaaa", kind: "entry", heading: body, text: null, bullets: [] });
  expect(changeCustomItemKind(entry, "tag")).toEqual({ id: "itm_aaaaaaaaaa", kind: "tag", text: body });
  expect(changeCustomItemKind(entry, "entry")).toBe(entry);
});
