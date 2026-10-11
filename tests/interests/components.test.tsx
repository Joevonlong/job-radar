import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

import { PatternList } from "@/components/interests/pattern-list";
import { ViewsPanel } from "@/components/interests/views-panel";
import { VocabularyForm } from "@/components/interests/vocabulary-form";
import { ViewTabs } from "@/components/jobs/view-tabs";
import type { SavedView } from "@/lib/config/schemas/interests";
import { IDLE_INTERESTS_STATE, type InterestsActionState } from "@/lib/interests/types";
import { configToDraft, type VocabularyFieldError } from "@/lib/interests/vocabulary-draft";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { shippedInterests } from "../signals/helpers";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

vi.mock("@/app/interests/actions", () => ({ deleteViewAction: vi.fn(), renameViewAction: vi.fn(), setDefaultViewAction: vi.fn() }));

describe("ViewsPanel trend label", () => {
  it("names the number: today's count and the total of the window, so a quiet day does not look like an empty view", () => {
    render(wrap(<ViewsPanel views={[{ id: "berlin", name: "Berlin", default: false, filters: { q: "Berlin" } }]} trends={{ berlin: [10, 12, 0, 20, 16, 20, 0] }} />));
    expect(screen.getByTestId("view-trend-today")).toHaveTextContent("Today 0");
    expect(screen.getByTestId("view-trend-total")).toHaveTextContent("7 d 78");
  });
});

describe("ViewsPanel filter tags", () => {
  const panel = (filters: SavedView["filters"], locale: "en" | "zh" = "en") => render(wrap(<ViewsPanel views={[{ id: "v", name: "V", default: false, filters }]} trends={{}} />, locale));

  it("joins several values with 'or' and names each one like the filter bar does", () => {
    panel({ city: ["Berlin", "München"], workplace: ["hybrid", "remote"], source: ["ats", "linkedin"], status: ["active", "closed"], contract: "permanent", app: ["new", "applied"] });
    const tags = screen.getByRole("list", { name: "Filters" });
    expect(tags).toHaveTextContent("City: Berlin or München");
    expect(tags).toHaveTextContent("Workplace: hybrid or remote");
    expect(tags).toHaveTextContent("Source: Company ATS or LinkedIn");
    expect(tags).toHaveTextContent("Job status: Open or Closed");
    // one value reads as before
    expect(tags).toHaveTextContent("Contract: Full-time · permanent");
    expect(tags).toHaveTextContent("Application status: New (untouched) or Applied");
  });

  it("is Berlin或München in Chinese, and a scalar view reads as one value", () => {
    panel({ city: ["Berlin", "München"], workplace: "remote" }, "zh");
    const tags = screen.getByRole("list", { name: "筛选条件" });
    expect(tags).toHaveTextContent("Berlin或München");
    expect(tags).toHaveTextContent("远程");
  });

  it("opens the view in /jobs with every value", () => {
    panel({ city: ["Berlin", "München"] });
    expect(screen.getByRole("link", { name: /V/ }).getAttribute("href")).toBe("/jobs?city=Berlin&city=M%C3%BCnchen");
  });
});

describe("PatternList", () => {
  it("adds, edits and removes rows and flags an invalid regex while typing", async () => {
    const user = userEvent.setup();
    let values = ["\\bequity\\b"];
    const onChange = vi.fn((next: string[]) => {
      values = next;
    });
    const { rerender } = render(wrap(<PatternList id="p" path="categories.1.patterns" values={values} onChange={onChange} errors={new Map()} addLabel="Add pattern" rowLabel="Patterns" emptyLabel="None yet" />));
    await user.click(screen.getByRole("button", { name: "Add pattern" }));
    expect(onChange).toHaveBeenLastCalledWith(["\\bequity\\b", ""]);

    rerender(wrap(<PatternList id="p" path="categories.1.patterns" values={["(unclosed"]} onChange={onChange} errors={new Map()} addLabel="Add pattern" rowLabel="Patterns" emptyLabel="None yet" />));
    expect(screen.getByRole("alert")).toHaveTextContent("Not a valid regular expression");
    expect(screen.getByRole("textbox", { name: "Patterns 1" })).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: "Remove Patterns 1" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("shows the server's error on its row and the list-level error", () => {
    const errors = new Map<string, VocabularyFieldError>([
      ["categories.0.patterns.1", { path: "categories.0.patterns.1", key: "regex" }],
      ["categories.0.patterns", { path: "categories.0.patterns", key: "atLeastOne" }],
    ]);
    render(wrap(<PatternList id="p" path="categories.0.patterns" values={["a", "b"]} onChange={() => {}} errors={errors} addLabel="Add" rowLabel="Patterns" emptyLabel="None" />, "zh"));
    expect(screen.getByRole("textbox", { name: "Patterns 2" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("不是有效的正则表达式")).toBeInTheDocument();
    expect(screen.getByText("至少要有一项")).toBeInTheDocument();
  });
});

describe("VocabularyForm (signal categories)", () => {
  const initial = configToDraft(shippedInterests());
  type Draft = typeof initial;

  function renderForm(state: InterestsActionState = IDLE_INTERESTS_STATE, onSave: (draft: Draft) => void = () => {}, locale: "en" | "zh" = "en") {
    return render(wrap(<VocabularyForm initial={initial} signalCounts={{ T3: { signals: 5, jobs: 4 } }} state={state} pending={false} onSave={onSave} />, locale));
  }
  const row = (id: string) => screen.getByTestId(`category-${id}`);
  const body = (id: string) => screen.getByTestId(`category-body-${id}`);
  const expand = (user: ReturnType<typeof userEvent.setup>, id: string) => user.click(screen.getByTestId(`category-toggle-${id}`));
  const meter = (id: string) => within(row(id)).getByRole("meter");
  const saved = (onSave: ReturnType<typeof vi.fn>): Draft => onSave.mock.calls.at(-1)?.[0] as Draft;

  it("lists the categories in order with their tag, kind and weight; a row opens to edit it, and Save sends the draft", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm(IDLE_INTERESTS_STATE, onSave);
    const rows = within(screen.getByTestId("category-list")).getAllByRole("listitem").filter((li) => li.dataset.testid?.startsWith("category-"));
    expect(rows.map((li) => li.dataset.testid)).toEqual(["category-T1", "category-T2", "category-T3", "category-T4", "category-tag"]);
    expect(within(row("T2")).getByText("Equity")).toBeInTheDocument();
    expect(screen.getByLabelText("Bonus cap")).toHaveValue("15");
    expect(screen.queryByTestId("category-body-T2")).toBeNull();

    await expand(user, "T2");
    expect(screen.getByTestId("category-toggle-T2")).toHaveAttribute("aria-expanded", "true");
    const weight = within(body("T2")).getByLabelText("Weight");
    expect(weight).toHaveValue("8");
    await user.clear(weight);
    await user.type(weight, "9");
    await user.type(within(body("T2")).getByLabelText("Words"), "Anteile{Enter}");
    await user.click(within(body("T2")).getByRole("checkbox", { name: "Needs AI confirmation" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const draft = saved(onSave);
    expect(draft.categories[1]).toMatchObject({ id: "T2", weight: "9", aiConfirmOnly: true });
    expect(draft.categories[1]?.keywords.at(-1)).toBe("Anteile");
    expect(draft.categories[0]).toEqual(initial.categories[0]);
  });

  it("the stepper and the weight boxes move the cells and the cap bar at once, and only Save sends them", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm(IDLE_INTERESTS_STATE, onSave);
    const cap = screen.getByTestId("cap-bar");
    // default weights: 10 + 8 + 3 + 2 + 0 = 23 against a cap of 15
    expect(cap).toHaveAttribute("data-sum", "23");
    expect(cap).toHaveAttribute("data-counted", "15");
    expect(screen.getByTestId("cap-overflow")).toBeInTheDocument();
    expect(meter("T2")).toHaveAttribute("aria-valuenow", "80");

    await expand(user, "T2");
    await expand(user, "T4");
    await user.click(screen.getByRole("button", { name: "Equity weight −1" }));
    expect(within(body("T2")).getByLabelText("Weight")).toHaveValue("7");
    expect(meter("T2")).toHaveAttribute("aria-valuenow", "70");
    expect(cap).toHaveAttribute("data-sum", "22");
    await user.click(screen.getByRole("button", { name: "Bonus weight +1" }));
    expect(cap).toHaveAttribute("data-sum", "23");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("2 unsaved")).toBeInTheDocument();

    const capInput = screen.getByLabelText("Bonus cap");
    await user.clear(capInput);
    await user.type(capInput, "30");
    expect(cap).toHaveAttribute("data-counted", "23");
    expect(screen.queryByTestId("cap-overflow")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved(onSave).categories.map((c) => c.weight)).toEqual(["10", "7", "3", "3", "0"]);
    expect(saved(onSave).bonusCap).toBe("30");
  });

  it("a weight above 10 grows the scale, so 20 is not drawn like 10 and the number agrees with the cells", async () => {
    const user = userEvent.setup();
    renderForm();
    expect(screen.getByTestId("weight-scale")).toHaveAttribute("data-per-cell", "1");
    await expand(user, "T1");
    const t1 = within(body("T1")).getByLabelText("Weight");
    await user.clear(t1);
    await user.type(t1, "20");
    expect(screen.getByTestId("weight-scale")).toHaveAttribute("data-per-cell", "2");
    expect(meter("T1")).toHaveAttribute("aria-valuenow", "100");
    expect(meter("T2")).toHaveAttribute("aria-valuenow", "40");
    expect(meter("T1").querySelectorAll("i.jr-on")).toHaveLength(10);
    expect(meter("T2").querySelectorAll("i.jr-on")).toHaveLength(4);
  });

  it("labels the cap bar's scale: 0 to the larger of the total and the cap, the track is full", () => {
    renderForm();
    expect(screen.getByTestId("cap-scale")).toHaveTextContent("0");
    expect(screen.getByTestId("cap-scale")).toHaveTextContent("23");
  });

  it("never steps a weight below 0", async () => {
    const user = userEvent.setup();
    renderForm();
    await expand(user, "T4");
    const down = screen.getByRole("button", { name: "Bonus weight −1" });
    await user.click(down);
    await user.click(down);
    await user.click(down);
    expect(within(body("T4")).getByLabelText("Weight")).toHaveValue("0");
  });

  it("opens the rows the server rejected and marks their fields", () => {
    const state: InterestsActionState = {
      status: "error",
      section: "vocabulary",
      nonce: 1,
      formError: null,
      fieldErrors: [
        { path: "categories.2.weight", key: "number" },
        { path: "bonusCap", key: "min", params: { min: 0 } },
        { path: "categories.0.patterns.0", key: "regex" },
        { path: "categories.1.kind", key: "kindLocked" },
      ],
    };
    renderForm(state);
    expect(within(body("T3")).getByLabelText("Weight")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a number")).toBeInTheDocument();
    expect(screen.getByText("Must be at least 0")).toBeInTheDocument();
    expect(within(body("T2")).getByText("A saved category keeps its kind")).toBeInTheDocument();
    expect(screen.getByText("4 fields need fixing; nothing was saved.")).toBeInTheDocument();
  });

  it("adds a category with the dialog: checks the id, picks a colour with the keyboard, and opens the new row", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm(IDLE_INTERESTS_STATE, onSave);
    await user.click(screen.getByTestId("category-add"));
    const dialog = screen.getByTestId("category-add-dialog");
    // an amount category exists: that kind cannot be picked again
    expect(within(dialog).getByTestId("category-add-kind-amount")).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Category id"), "9visa");
    await user.click(within(dialog).getByTestId("category-add-submit"));
    expect(within(dialog).getByTestId("category-add-id-error")).toHaveTextContent("Invalid id");
    await user.clear(within(dialog).getByLabelText("Category id"));
    await user.type(within(dialog).getByLabelText("Category id"), "t2");
    await user.click(within(dialog).getByTestId("category-add-submit"));
    expect(within(dialog).getByTestId("category-add-id-error")).toHaveTextContent("already used");

    await user.clear(within(dialog).getByLabelText("Category id"));
    await user.type(within(dialog).getByLabelText("Category id"), "visa");
    await user.type(within(dialog).getByLabelText("English name"), "Visa sponsorship");
    const colours = within(dialog).getByRole("radiogroup", { name: "Colour" });
    const checked = within(colours).getByRole("radio", { checked: true });
    checked.focus();
    await user.keyboard("{ArrowRight}");
    expect(within(colours).getByRole("radio", { checked: true })).not.toBe(checked);
    await user.click(within(colours).getByRole("radio", { name: "Pink" }));
    await user.click(within(dialog).getByTestId("category-add-submit"));

    expect(screen.queryByTestId("category-add-dialog")).toBeNull();
    expect(body("visa")).toBeInTheDocument();
    expect(within(row("visa")).getByText("unsaved")).toBeInTheDocument();
    await user.type(within(body("visa")).getByLabelText("Definition for the AI (English)"), "the employer sponsors a work visa");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved(onSave).categories.at(-1)).toMatchObject({ id: "visa", kind: "keyword", labelEn: "Visa sponsorship", color: "pink", aiDefinition: "the employer sponsors a work visa" });
  });

  it("moves a category up and down with buttons", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm(IDLE_INTERESTS_STATE, onSave);
    expect(screen.getByRole("button", { name: "Move Explicit amount up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move Bonus up" }));
    await user.click(screen.getByRole("button", { name: "Move Equity down" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved(onSave).categories.map((c) => c.id)).toEqual(["T1", "T4", "T2", "T3", "tag"]);
  });

  it("deleting asks first, says how many stored signals it hides, and moves the category to the deleted ones, which can be restored", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm(IDLE_INTERESTS_STATE, onSave);
    await user.click(screen.getByRole("button", { name: "Delete Competitive" }));
    const dialog = screen.getByTestId("category-delete-dialog");
    expect(within(dialog).getByTestId("category-delete-body")).toHaveTextContent("5 signals of this category on 4 jobs");
    await user.click(within(dialog).getByTestId("category-delete-confirm"));
    expect(screen.queryByTestId("category-T3")).toBeNull();
    const retired = screen.getByTestId("retired-panel");
    expect(within(retired).getByText("Competitive")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved(onSave).retired.map((c) => c.id)).toEqual(["T3"]);
    expect(saved(onSave).categories.map((c) => c.id)).toEqual(["T1", "T2", "T4", "tag"]);

    await user.click(within(retired).getByRole("button", { name: "Restore Competitive" }));
    expect(screen.queryByTestId("retired-panel")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved(onSave).categories.map((c) => c.id)).toEqual(["T1", "T2", "T4", "tag", "T3"]);
  });

  it("speaks Chinese", () => {
    renderForm(IDLE_INTERESTS_STATE, () => {}, "zh");
    expect(within(row("T2")).getByText("股权")).toBeInTheDocument();
    expect(screen.getByTestId("category-add")).toHaveTextContent("新增类别");
    expect(screen.getByText("信号类别（5/12）")).toBeInTheDocument();
  });
});

describe("ViewTabs", () => {
  const tabs = [
    { key: "all", label: "All", href: "/?view=all", active: false, isDefault: false },
    { key: "berlin", label: "Berlin", href: "/?view=berlin", active: true, isDefault: true },
  ];

  it("renders a segment per view, marks the active one and the default view", () => {
    render(wrap(<ViewTabs tabs={tabs} />));
    const group = screen.getByRole("radiogroup", { name: "Views" });
    const berlin = within(group).getByRole("radio", { name: /Berlin/ });
    expect(berlin).toBeChecked();
    expect(berlin).toHaveAttribute("data-active", "true");
    expect(within(berlin).getByLabelText("Default view")).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "All" })).not.toBeChecked();
  });

  it("goes to the URL of the chosen view", async () => {
    const user = userEvent.setup();
    render(wrap(<ViewTabs tabs={tabs} />));
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(replace).toHaveBeenCalledWith("/?view=all");
  });
});
