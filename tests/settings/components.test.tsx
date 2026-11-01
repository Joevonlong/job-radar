import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfigForm } from "@/components/settings/config-form";
import { OrderedList } from "@/components/settings/field-editors";
import { configToDraft } from "@/lib/settings/draft";
import type { SettingsActionState, SettingsSection } from "@/lib/settings/types";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { bareCatalogView, shippedCatalogView, shippedConfig } from "./helpers";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

describe("OrderedList", () => {
  it("moves, removes and adds entries", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(wrap(<OrderedList id="cascade" values={["a", "b", "c"]} options={["a", "b", "c", "d"]} onChange={onChange} invalid={false} describedBy={undefined} />));

    await user.click(screen.getByRole("button", { name: "Move b up" }));
    expect(onChange).toHaveBeenLastCalledWith(["b", "a", "c"]);
    await user.click(screen.getByRole("button", { name: "Move b down" }));
    expect(onChange).toHaveBeenLastCalledWith(["a", "c", "b"]);
    await user.click(screen.getByRole("button", { name: "Remove c" }));
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Add" }), "d");
    expect(onChange).toHaveBeenLastCalledWith(["a", "b", "c", "d"]);
  });

  it("cannot move the first entry up or the last one down", () => {
    render(wrap(<OrderedList id="cascade" values={["a", "b"]} options={["a", "b"]} onChange={() => {}} invalid={false} describedBy={undefined} />));
    expect(screen.getByRole("button", { name: "Move a up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move b down" })).toBeDisabled();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

function section(tab: "search" | "channels" | "ai" | "schedule"): SettingsSection {
  return { tab, hash: "h1", draft: configToDraft(tab, shippedConfig(tab)), loadError: null };
}

describe("ConfigForm", () => {
  it("renders the search form from the config and sends the edited draft", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={{ status: "idle" }} pending={false} onSave={onSave} ack={null} />));

    expect(screen.getAllByTestId("keyword-group")).toHaveLength(3);
    const morning = screen.getByRole("textbox", { name: "Morning look-back (hours)" });
    expect(morning).toHaveValue("24");
    await user.clear(morning);
    await user.type(morning, "36");
    expect(screen.getByText("1 unsaved")).toBeInTheDocument();
    // the changed field is marked, the untouched ones are not
    expect(morning.closest("[data-dirty]")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Evening look-back (hours)" }).closest("[data-dirty]")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ "window_hours.morning": "36", remote_scope: "home_country" });
  });

  it("shows a field error next to its field only while the file is unchanged", () => {
    const state: SettingsActionState = {
      status: "error",
      tab: "search",
      baseHash: "h1",
      fieldErrors: [{ path: "window_hours.evening", key: "number" }],
      formError: null,
    };
    const { rerender } = render(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={state} pending={false} onSave={() => {}} ack={null} />));
    const input = screen.getByRole("textbox", { name: "Evening look-back (hours)" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a number");

    rerender(wrap(<ConfigForm tab="search" section={{ ...section("search"), hash: "h2" }} file="search.yaml" state={state} pending={false} onSave={() => {}} ack={null} />));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("groups the channels form into one collapsible section per channel, with the cascade as a list", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(<ConfigForm tab="channels" section={section("channels")} file="sources.yaml" state={{ status: "idle" }} pending={false} onSave={onSave} ack={null} />));

    const brightdata = screen.getByTestId("section-linkedin-brightdata");
    expect(brightdata.tagName).toBe("DETAILS");
    expect(brightdata.querySelector("summary [data-enabled='1']")).toHaveTextContent("Enabled");
    expect(screen.getByTestId("section-linkedin-session").querySelector("summary [data-enabled='0']")).toHaveTextContent("Disabled");
    expect(screen.getByTestId("section-jobspy-google").tagName).toBe("DETAILS");

    const list = screen.getByTestId(/-list$/);
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-value"))).toEqual(["linkedin-brightdata", "linkedin-apify", "linkedin-monid", "linkedin-session", "linkedin-guest"]);
    await user.click(screen.getByRole("button", { name: "Move linkedin-guest up" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]?.[0]["linkedin.cascade"]).toEqual(["linkedin-brightdata", "linkedin-apify", "linkedin-monid", "linkedin-guest", "linkedin-session"]);
  });

  it("opens a channel section that holds an error", () => {
    const state: SettingsActionState = {
      status: "error",
      tab: "channels",
      baseHash: "h1",
      fieldErrors: [{ path: "sources.indeed.monthly_budget_usd", key: "overBudgetCap" }],
      formError: null,
    };
    render(wrap(<ConfigForm tab="channels" section={section("channels")} file="sources.yaml" state={state} pending={false} onSave={() => {}} ack={null} />));
    expect(screen.getByTestId("section-indeed")).toHaveAttribute("open");
    expect(screen.getByTestId("section-lever")).not.toHaveAttribute("open");
    expect(screen.getByText("Must not exceed the paid total monthly cap")).toBeInTheDocument();
  });

  it("scrolls to and focuses the first invalid field after a failed save, and again after the next failed save", () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const failed = (path: string): SettingsActionState => ({ status: "error", tab: "search", baseHash: "h1", fieldErrors: [{ path, key: "number" }], formError: null });
      const first = failed("window_hours.morning");
      const { rerender } = render(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} />));
      expect(scroll).not.toHaveBeenCalled();

      rerender(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={first} pending={false} onSave={() => {}} ack={null} />));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(screen.getByRole("textbox", { name: "Morning look-back (hours)" }));
      expect(screen.getByRole("textbox", { name: "Morning look-back (hours)" })).toHaveFocus();

      // another failed save (a new state object) brings the first problem into view again
      rerender(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={failed("window_hours.evening")} pending={false} onSave={() => {}} ack={null} />));
      expect(scroll).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("textbox", { name: "Evening look-back (hours)" })).toHaveFocus();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("does not scroll for an error of another tab, and opens the collapsed section that holds the problem first", () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const other: SettingsActionState = { status: "error", tab: "channels", baseHash: "h1", fieldErrors: [{ path: "window_hours.evening", key: "number" }], formError: null };
      const { rerender } = render(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={other} pending={false} onSave={() => {}} ack={null} />));
      expect(scroll).not.toHaveBeenCalled();

      const inChannel: SettingsActionState = { status: "error", tab: "channels", baseHash: "h1", fieldErrors: [{ path: "sources.indeed.monthly_budget_usd", key: "overBudgetCap" }], formError: null };
      rerender(wrap(<ConfigForm tab="channels" section={section("channels")} file="sources.yaml" state={inChannel} pending={false} onSave={() => {}} ack={null} />));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("section-indeed")).toHaveAttribute("open");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  const aiForm = (props: Partial<React.ComponentProps<typeof ConfigForm>> & { draft?: Record<string, unknown> } = {}) => {
    const { draft, ...rest } = props;
    const base = section("ai");
    return (
      <ConfigForm
        tab="ai"
        section={draft ? { ...base, draft: { ...base.draft, ...draft } as never } : base}
        file="ai.yaml"
        state={{ status: "idle" }}
        pending={false}
        onSave={() => {}}
        ack={null}
        catalog={bareCatalogView()}
        catalogError={null}
        {...rest}
      />
    );
  };
  const optionTexts = (select: HTMLElement) => within(select).getAllByRole("option").map((option) => option.textContent);

  it("a model dropdown lists only its own provider's catalog, with names and prices, and no tag box is left", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(aiForm({ onSave })));
    const claude = screen.getByTestId("section-claude_cli");
    const model = within(claude).getByRole("combobox", { name: "Model" });
    expect(model).toHaveValue("claude-haiku-4-5");
    expect(optionTexts(model)).toEqual(["Claude Haiku 4.5 · claude-haiku-4-5", "Claude Sonnet 5.5 · claude-sonnet-5-5", "Claude Opus 5.5 · claude-opus-5-5"]);
    expect(within(claude).queryByRole("textbox", { name: "Models" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /models/i })).toBeNull();
    // API providers show the price per 1M tokens; the same model id under the CLI shows none
    const deepseek = within(screen.getByTestId("section-deepseek")).getByRole("combobox", { name: "Model" });
    expect(optionTexts(deepseek)).toEqual(["DeepSeek V4 Flash · deepseek-v4-flash · $0.3 / $1.2", "DeepSeek V4 Pro · deepseek-v4-pro · $1.32 / $3.96"]);
    expect(optionTexts(within(screen.getByTestId("section-anthropic")).getByRole("combobox", { name: "Model" }))[0]).toBe("Claude Haiku 4.5 · claude-haiku-4-5 · $1 / $5");
    expect(screen.queryByText(/Model prices/i)).toBeNull();

    await user.selectOptions(model, "claude-opus-5-5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ "providers.claude_cli.model": "claude-opus-5-5" });
  });

  it("each provider row shows the model in use; the vendor card closes with the catalog tables", () => {
    render(wrap(aiForm()));
    const claude = screen.getByTestId("section-claude_cli");
    expect(within(screen.getByTestId("vendor-anthropic")).getByTestId("vendor-active")).toHaveTextContent("Claude Haiku 4.5");
    expect(within(screen.getByTestId("vendor-openai")).getByTestId("vendor-active")).toHaveTextContent("CLI default");
    expect(within(claude).queryByTestId("section-model")).toBeNull();
    const table = screen.getByTestId("model-catalog-claude-cli");
    const rows = within(table).getAllByTestId("catalog-row");
    expect(rows.map((r) => r.getAttribute("data-model"))).toEqual(["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(within(rows[0] as HTMLElement).getByText("In use")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Subscription")).toBeInTheDocument();
    expect(within(screen.getByTestId("model-catalog-deepseek")).getAllByTestId("catalog-row")).toHaveLength(2);
    expect(within(table).getByText(/models\.yaml/, { selector: "h4" })).toBeInTheDocument();
    // codex: the table has the efforts column and marks the CLI default
    const codexRow = within(screen.getByTestId("model-catalog-codex-cli")).getByTestId("catalog-row");
    expect(within(codexRow).getByText("CLI default")).toBeInTheDocument();
    expect(within(codexRow).getByText("All")).toBeInTheDocument();
  });

  it("a subscription model with an equivalent price shows it, with the source as tooltip", () => {
    const catalog = bareCatalogView((raw) => {
      raw.providers["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, source: "Anthropic price list, 2026-10" };
    });
    render(wrap(<ConfigForm tab="ai" section={section("ai")} file="ai.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} catalog={catalog} catalogError={null} />));
    const rows = within(screen.getByTestId("model-catalog-claude-cli")).getAllByTestId("catalog-row");
    expect(within(rows[0] as HTMLElement).getByText("Subscription · equiv. $1 / $5")).toHaveAttribute("title", "Anthropic price list, 2026-10");
    expect(within(rows[1] as HTMLElement).getByText("Subscription")).toBeInTheDocument();
  });

  it("a deprecated selection stays visible and flagged, one outside the catalog is shown as such, a deprecated model is not offered", () => {
    const catalog = shippedCatalogView((raw) => {
      raw.providers["claude-cli"].models[0].deprecated = true;
      raw.providers.deepseek.models[1].deprecated = true;
    });
    render(wrap(aiForm({ catalog, draft: { "providers.anthropic.model": "claude-legacy" } })));
    const claude = screen.getByTestId("section-claude_cli");
    const model = within(claude).getByRole("combobox", { name: "Model" });
    expect(optionTexts(model)).toEqual(["Claude Haiku 4.5 · claude-haiku-4-5 (deprecated)", "Claude Sonnet 5.5 · claude-sonnet-5-5", "Claude Opus 5.5 · claude-opus-5-5"]);
    expect(within(claude).getByText("Deprecated", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    // not selected: not offered
    expect(optionTexts(within(screen.getByTestId("section-deepseek")).getByRole("combobox", { name: "Model" }))).toHaveLength(1);
    // not in the catalog at all
    const anthropic = screen.getByTestId("section-anthropic");
    expect(within(anthropic).getByRole("combobox", { name: "Model" })).toHaveValue("claude-legacy");
    expect(within(anthropic).getByRole("option", { name: "claude-legacy (not in the model catalog)" })).toBeInTheDocument();
    expect(within(anthropic).getByText("Not in catalog")).toBeInTheDocument();
  });

  it("codex efforts follow the chosen model", async () => {
    const user = userEvent.setup();
    const catalog = shippedCatalogView((raw) => {
      raw.providers["codex-cli"].models[0].reasoning_efforts = ["low", "medium"];
      raw.providers["codex-cli"].models.push({ id: "gpt-mini", reasoning_efforts: ["minimal", "low"] });
    });
    render(wrap(aiForm({ catalog })));
    const codex = screen.getByTestId("section-codex_cli");
    const model = within(codex).getByRole("combobox", { name: "Model" });
    const effort = within(codex).getByRole("combobox", { name: "Reasoning effort" });
    expect(optionTexts(model)[0]).toBe("CLI default (GPT-6.1 Sol)");
    expect(optionTexts(effort)).toEqual(["low", "medium"]);
    await user.selectOptions(model, "gpt-mini");
    expect(optionTexts(effort)).toEqual(["minimal", "low"]);
    // the current effort (low) is still supported; pick medium first and the model change then flags it
    await user.selectOptions(model, "");
    await user.selectOptions(effort, "medium");
    await user.selectOptions(model, "gpt-mini");
    expect(within(codex).getByRole("option", { name: "medium (not supported by this model)" })).toBeInTheDocument();
  });

  it("a task route picks a provider, then its model; removing the provider drops the model", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(aiForm({ onSave })));
    // read mode is a compact line without the editor; Edit opens it in place
    expect(screen.queryByTestId(/-tasks\.translate-list$/)).toBeNull();
    await user.click(screen.getByTestId("task-row-translate-edit"));
    const list = screen.getByTestId(/-tasks\.translate-list$/);
    const claudeRow = within(list).getAllByTestId("route-row").find((r) => r.getAttribute("data-value") === "claude-cli") as HTMLElement;
    const select = within(claudeRow).getByRole("combobox", { name: "Model for Anthropic · Subscription" });
    expect(optionTexts(select)).toEqual(["Default · claude-haiku-4-5", "Claude Haiku 4.5 · claude-haiku-4-5", "Claude Sonnet 5.5 · claude-sonnet-5-5", "Claude Opus 5.5 · claude-opus-5-5"]);
    // the api layer has no model dropdown
    const apiRow = within(list).getAllByTestId("route-row").find((r) => r.getAttribute("data-value") === "api") as HTMLElement;
    expect(within(apiRow).queryByRole("combobox")).toBeNull();
    expect(within(apiRow).getByTestId("route-api-note")).toBeInTheDocument();
    // codex shows the CLI default as its default model
    const codexRow = within(list).getAllByTestId("route-row").find((r) => r.getAttribute("data-value") === "codex-cli") as HTMLElement;
    expect(within(codexRow).getByRole("combobox", { name: "Model for OpenAI · Subscription" })).toHaveDisplayValue("Default · CLI default");

    await user.selectOptions(select, "claude-sonnet-5-5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]?.[0]["tasks.translate"]).toEqual([
      { provider: "codex-cli", model: "" },
      { provider: "claude-cli", model: "claude-sonnet-5-5" },
      { provider: "api", model: "" },
    ]);
    await user.click(within(claudeRow).getByRole("button", { name: "Remove Anthropic · Subscription" }));
    await user.selectOptions(within(screen.getByTestId(/-tasks\.translate-list$/).parentElement as HTMLElement).getByRole("combobox", { name: "Add" }), "claude-cli");
    const again = within(screen.getByTestId(/-tasks\.translate-list$/)).getAllByTestId("route-row").find((r) => r.getAttribute("data-value") === "claude-cli") as HTMLElement;
    expect(within(again).getByRole("combobox", { name: "Model for Anthropic · Subscription" })).toHaveValue("");
  });

  it("an Anthropic card has a subscription row and an API row with their own switches; a task can go back to the global order", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(aiForm({ onSave })));
    const card = screen.getByTestId("vendor-anthropic");
    const cli = within(card).getByTestId("section-claude_cli");
    const api = within(card).getByTestId("section-anthropic");
    await user.click(within(api).getByRole("switch", { name: "Enable Anthropic API" }));
    expect(api).toHaveAttribute("data-enabled", "0");
    expect(cli).toHaveAttribute("data-enabled", "1");
    await user.click(screen.getByTestId("task-row-translate-edit"));
    await user.click(within(screen.getByTestId("task-row-translate")).getByRole("button", { name: "Follow the global order" }));
    expect(screen.getByTestId("task-row-translate")).toHaveAttribute("data-custom", "0");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ "providers.anthropic.enabled": false, "providers.claude_cli.enabled": true, "tasks.translate": [] });
  });

  it("an OpenRouter row keeps its routing toggles under More settings; only the enabled switch sits in the header", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(aiForm({ onSave })));
    const row = screen.getByTestId("section-openrouter");
    const more = within(row).getByTestId("more-openrouter");
    expect(within(row).getAllByRole("switch", { name: "Enable OpenRouter API" })).toHaveLength(1);
    expect(within(more).getByRole("switch", { name: "Zero data retention only" })).not.toBeChecked();
    expect(within(more).getByRole("switch", { name: "Require JSON support" })).toBeChecked();
    expect(within(more).getByRole("switch", { name: "JSON mode only" })).toBeInTheDocument();
    await user.click(within(more).getByRole("switch", { name: "Zero data retention only" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ "providers.openrouter.routing.zdr": true });
  });

  it("the order lists show the model each provider uses", async () => {
    const user = userEvent.setup();
    render(wrap(aiForm({ draft: { "providers.codex_cli.model": "gpt-6.1-sol" } })));
    await user.click(screen.getByTestId("order-row-order-edit"));
    const order = screen.getByTestId("section-order");
    const detail = (value: string) => within(within(order).getAllByRole("listitem").find((i) => i.getAttribute("data-value") === value) as HTMLElement).getByTestId("option-detail");
    expect(detail("codex-cli")).toHaveTextContent("· gpt-6.1-sol");
    expect(detail("claude-cli")).toHaveTextContent("· claude-haiku-4-5");
    expect(detail("api")).toHaveTextContent("→ deepseek, anthropic, mimo");
    // one editor at a time: opening the API-layer order closes the global one
    await user.click(screen.getByTestId("order-row-api_order-edit"));
    expect(screen.queryByTestId("order-row-order-editor")).toBeNull();
    expect(detail("deepseek")).toHaveTextContent("· deepseek-v4-flash");
  });

  it("an unreadable catalog shows the red box", () => {
    const { rerender } = render(wrap(aiForm({ catalog: null, catalogError: "models.yaml: providers.mimo.models.0.price: required" })));
    expect(screen.getByTestId("catalog-error")).toHaveTextContent("models.yaml cannot be read: models.yaml: providers.mimo.models.0.price: required");
    // the dropdowns show the current value only
    expect(optionTexts(within(screen.getByTestId("section-claude_cli")).getByRole("combobox", { name: "Model" }))).toEqual(["claude-haiku-4-5"]);
    expect(screen.queryByTestId("model-catalog-claude-cli")).toBeNull();
    rerender(wrap(aiForm()));
    expect(screen.queryByTestId("catalog-error")).toBeNull();
  });

  it("Chinese text; the catalog names the models.yaml in use", () => {
    render(wrap(aiForm({ section: { ...section("ai"), catalogFile: "data/config/models.yaml" } }), "zh"));
    expect(screen.getByTestId("model-catalog-claude-cli")).toHaveTextContent("模型目录 · data/config/models.yaml");
    expect(within(screen.getByTestId("section-claude_cli")).getByRole("combobox", { name: "模型" })).toBeInTheDocument();
  });

  it("marks AI providers that cannot run in the order lists and the add pickers", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <ConfigForm
          tab="ai"
          section={section("ai")}
          file="ai.yaml"
          state={{ status: "idle" }}
          pending={false}
          onSave={() => {}}
          ack={null}
          providerStates={{ "claude-cli": "auth", "codex-cli": "ready", deepseek: "unconfigured", mimo: "cooling" }}
        />,
      ),
    );
    await user.click(screen.getByTestId("order-row-order-edit"));
    const order = screen.getByTestId("section-order");
    const claude = within(order).getAllByRole("listitem").find((item) => item.getAttribute("data-value") === "claude-cli");
    expect(claude).toHaveTextContent("login failed");
    const codex = within(order).getAllByRole("listitem").find((item) => item.getAttribute("data-value") === "codex-cli");
    expect(within(codex as HTMLElement).queryByTestId("option-note")).toBeNull();
    await user.click(screen.getByTestId("order-row-api_order-edit"));
    expect(within(screen.getByTestId("section-order")).getAllByText("not configured").length).toBeGreaterThan(0);
  });

  it("speaks Chinese too", () => {
    render(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} />, "zh"));
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "早轮回看时间窗（小时）" })).toBeInTheDocument();
  });
});

describe("ConfigForm save bar and schedule timeline", () => {
  const scheduleTimeline = { quiet: { enabled: true, start: "22:00", end: "07:00" }, timeZone: "Europe/Berlin", now: "2026-10-08T16:04:00Z" };

  it("counts the changed fields, reverts them, and keeps Save off while nothing changed", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={{ status: "idle" }} pending={false} onSave={onSave} ack={<span>runner loaded</span>} />));

    const bar = screen.getByTestId("save-bar");
    expect(bar).toHaveAttribute("data-dirty", "false");
    expect(within(bar).getByText("No unsaved changes")).toBeInTheDocument();
    expect(within(bar).getByText("runner loaded")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Reset" })).toBeDisabled();

    const morning = screen.getByRole("textbox", { name: "Morning look-back (hours)" });
    const evening = screen.getByRole("textbox", { name: "Evening look-back (hours)" });
    await user.clear(morning);
    await user.type(morning, "36");
    await user.clear(evening);
    await user.type(evening, "12");
    expect(bar).toHaveAttribute("data-dirty", "true");
    expect(within(bar).getByText("2 unsaved")).toBeInTheDocument();

    await user.click(within(bar).getByRole("button", { name: "Reset" }));
    expect(morning).toHaveValue("24");
    expect(within(bar).getByText("No unsaved changes")).toBeInTheDocument();

    // nothing changed: Save is off; a change turns it on and the save goes out
    expect(within(bar).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(morning, "0");
    await user.click(within(bar).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("uses switches for booleans", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(wrap(<ConfigForm tab="schedule" section={section("schedule")} file="schedule.yaml" state={{ status: "idle" }} pending={false} onSave={onSave} ack={null} timeline={scheduleTimeline} />));
    const catchUp = screen.getByRole("switch", { name: /catch up/i });
    expect(catchUp).toBeChecked();
    await user.click(catchUp);
    expect(catchUp).not.toBeChecked();
    expect(screen.getByText("1 unsaved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ catch_up: false });
  });

  it("draws the day from the schedule: runs at their cron times, quiet hours across midnight, now in the schedule's zone", () => {
    render(wrap(<ConfigForm tab="schedule" section={section("schedule")} file="schedule.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} timeline={scheduleTimeline} />));
    const timeline = screen.getByTestId("schedule-timeline");
    const runs = within(timeline).getAllByTestId("timeline-run");
    expect(runs.map((run) => `${run.getAttribute("data-kind")}@${run.getAttribute("data-minutes")}`)).toEqual(["weekday@420", "weekend@540", "weekday@1020"]);
    expect(within(timeline).getAllByTestId("timeline-quiet").map((q) => `${q.getAttribute("data-from")}-${q.getAttribute("data-to")}`)).toEqual(["0-420", "1320-1440"]);
    // 16:04 UTC is 18:04 in Berlin (CEST)
    expect(within(timeline).getByTestId("timeline-now")).toHaveAttribute("data-minutes", String(18 * 60 + 4));
    expect(within(timeline).getByTestId("timeline-zone")).toHaveTextContent("Europe/Berlin");
    expect(within(timeline).getByRole("img")).toHaveAccessibleName(/07:00 · 17:00/);
  });

  it("follows a cron that is being edited, before saving", async () => {
    const user = userEvent.setup();
    render(wrap(<ConfigForm tab="schedule" section={section("schedule")} file="schedule.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} timeline={scheduleTimeline} />));
    const cron = screen.getAllByRole("textbox", { name: "Cron expression" })[2] as HTMLElement; // the weekend cycle
    await user.clear(cron);
    await user.type(cron, "0 10 * * 6,0");
    const runs = screen.getAllByTestId("timeline-run");
    expect(runs.map((run) => run.getAttribute("data-minutes"))).toEqual(["420", "600", "1020"]);
    // half-typed or invalid: the slot just disappears, nothing throws
    await user.clear(cron);
    await user.type(cron, "0 10 *");
    expect(screen.getAllByTestId("timeline-run")).toHaveLength(2);
  });

  it("writes what each cron means next to its box, in words, and follows the edit", async () => {
    const user = userEvent.setup();
    render(wrap(<ConfigForm tab="schedule" section={section("schedule")} file="schedule.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} timeline={scheduleTimeline} />));
    const chips = screen.getAllByTestId("cron-chip");
    expect(chips.slice(0, 3).map((chip) => chip.textContent)).toEqual(["Weekdays 07:00", "Weekdays 17:00", "Weekends 09:00"]);
    const cron = screen.getAllByRole("textbox", { name: "Cron expression" })[0] as HTMLElement;
    expect(cron).toHaveValue("0 7 * * 1-5"); // still the editable truth
    await user.clear(cron);
    await user.type(cron, "30 6,18 * * *");
    expect(screen.getAllByTestId("cron-chip")[0]).toHaveTextContent("Every day 06:30 · 18:30");
    await user.clear(cron);
    await user.type(cron, "nonsense");
    expect(screen.getAllByTestId("cron-chip")[0]).toHaveAttribute("data-valid", "false");
  });

  it("puts the unit inside number boxes", () => {
    render(wrap(<ConfigForm tab="search" section={section("search")} file="search.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} />));
    const box = screen.getByRole("textbox", { name: "Morning look-back (hours)" }).closest("[data-slot=input-group]");
    expect(box).not.toBeNull();
    expect(box?.querySelector("[data-slot=input-suffix]")).toHaveTextContent("h");
  });

  it("keeps a switched-off cycle on the timeline, dimmed, with its time", async () => {
    const user = userEvent.setup();
    render(wrap(<ConfigForm tab="schedule" section={section("schedule")} file="schedule.yaml" state={{ status: "idle" }} pending={false} onSave={() => {}} ack={null} timeline={scheduleTimeline} />));
    await user.click(screen.getAllByRole("switch", { name: /run this cycle/i })[2] as HTMLElement);
    const runs = screen.getAllByTestId("timeline-run");
    expect(runs).toHaveLength(3);
    const off = runs.find((run) => run.getAttribute("data-enabled") === "false");
    expect(off).toHaveAttribute("data-minutes", "540");
    expect(off).toHaveTextContent("09:00");
    expect(screen.getByTestId("timeline-off-legend")).toBeInTheDocument();
  });
});

describe("ConfigForm: language code", () => {
  it("shows the problem while typing and keeps Save off", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const section: SettingsSection = { tab: "language", hash: "h1", draft: configToDraft("language", shippedConfig("language")), loadError: null };
    render(wrap(<ConfigForm tab="language" section={section} file="language.yaml" state={{ status: "idle" }} pending={false} onSave={onSave} ack={null} />));
    const box = screen.getByRole("textbox", { name: "AI language" });
    await user.clear(box);
    await user.type(box, "english");
    expect(screen.getByText("A language code such as en, zh, de or pt-BR")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(box);
    await user.type(box, "pt-BR");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
