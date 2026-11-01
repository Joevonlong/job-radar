import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { withNuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { FilterBar, type FilterBarOptions } from "@/components/jobs/filter-bar";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

beforeAll(() => {
  // jsdom: cmdk scrolls the highlighted item into view
  Element.prototype.scrollIntoView = vi.fn();
});

const options = { families: ["ats", "linkedin"], cities: [{ key: "Berlin", target: false }, { key: "München", target: false }], contracts: ["permanent"] };

function renderBar(searchParams = "", locale: "en" | "zh" = "en", extra: Partial<FilterBarOptions> = {}) {
  const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>();
  const Adapter = withNuqsTestingAdapter({ searchParams, onUrlUpdate, hasMemory: true });
  const { unmount } = render(
    <Adapter>
      <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
        <FilterBar options={{ ...options, ...extra }} />
      </NextIntlClientProvider>
    </Adapter>,
  );
  const lastQuery = () => onUrlUpdate.mock.calls.at(-1)?.[0].queryString ?? "";
  return { onUrlUpdate, lastQuery, unmount };
}

describe("FilterBar: application status", () => {
  it("offers every status as a toggle, in pipeline order, with ignored among them", () => {
    renderBar();
    const group = screen.getByTestId("filter-app");
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["New (untouched)", "Interested", "Preparing", "Applied", "Interviewing", "Offer", "Rejected", "Withdrawn", "Ignored"]);
  });

  it("speaks Chinese: ignored is 已忽略", () => {
    renderBar("", "zh");
    expect(screen.getByTestId("filter-app-archived")).toHaveTextContent("已忽略");
    expect(screen.getByTestId("filter-app-new")).toHaveTextContent("新（未处理）");
  });

  it("picks several statuses (repeated URL keys) and unpicks them again", async () => {
    const { lastQuery } = renderBar("?page=3");
    // The toggle computes the next list from the committed render (nuqs state behind a transition), not from the
    // URL event. So after every click wait for the button state to commit before the next click, otherwise a
    // loaded machine lets the next click read the stale list.
    const pressed = (id: string, value: boolean) => waitFor(() => expect(screen.getByTestId(id)).toHaveAttribute("aria-pressed", String(value)));
    const user = userEvent.setup();

    await user.click(screen.getByTestId("filter-app-archived"));
    await pressed("filter-app-archived", true);
    await waitFor(() => expect(lastQuery()).toBe("?app=archived"));

    await user.click(screen.getByTestId("filter-app-interested"));
    await pressed("filter-app-interested", true);
    // pipeline order, not click order; the page goes back to 1
    await waitFor(() => expect(lastQuery()).toBe("?app=interested&app=archived"));

    await user.click(screen.getByTestId("filter-app-archived"));
    await pressed("filter-app-archived", false);
    await waitFor(() => expect(lastQuery()).toBe("?app=interested"));

    await user.click(screen.getByTestId("filter-app-interested"));
    await pressed("filter-app-interested", false);
    await waitFor(() => expect(lastQuery()).toBe(""));
  });

  it("shows the statuses of the URL as pressed", () => {
    renderBar("?app=applied&app=offer");
    expect(screen.getByTestId("filter-app-applied")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("filter-app-offer")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("filter-app-new")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("FilterBar: minimum score and salary", () => {
  it("writes the numbers to the URL once typing pauses, and clears them when emptied", async () => {
    const { lastQuery } = renderBar();
    const score = screen.getByTestId("filter-min-score");
    await userEvent.type(score, "75");
    // the box follows typing at once
    expect(score).toHaveValue(75);
    await waitFor(() => expect(lastQuery()).toBe("?minScore=75"), { timeout: 2000 });

    const salary = screen.getByTestId("filter-min-salary");
    await userEvent.type(salary, "70000");
    await waitFor(() => expect(lastQuery()).toBe("?minScore=75&minSalary=70000"), { timeout: 2000 });

    await userEvent.clear(score);
    await waitFor(() => expect(lastQuery()).toBe("?minSalary=70000"), { timeout: 2000 });
  });

  it("caps the score at 100 and ignores negative input", async () => {
    const { lastQuery } = renderBar();
    const score = screen.getByTestId("filter-min-score");
    await userEvent.type(score, "250");
    await waitFor(() => expect(lastQuery()).toBe("?minScore=100"), { timeout: 2000 });
    expect(score).toHaveAttribute("min", "0");
  });

  it("shows the values from the URL and the clear button resets all new filters", async () => {
    const { lastQuery } = renderBar("?app=new&minScore=60&minSalary=70000&q=rust");
    expect(screen.getByTestId("filter-min-score")).toHaveValue(60);
    expect(screen.getByTestId("filter-min-salary")).toHaveValue(70000);
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe(""));
  });
});

describe("FilterBar on a phone", () => {
  it("collapses the filters behind a Filters (n) button that counts them, without the search text", () => {
    renderBar("?q=rust&app=new&app=applied&minScore=60&city=Berlin");
    const toggle = screen.getByTestId("filter-toggle");
    expect(toggle).toHaveTextContent("Filters (3)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("filter-panel")).toHaveAttribute("data-open", "false");
    // hidden on the phone by CSS (max-md:hidden), shown from md up
    expect(screen.getByTestId("filter-panel").className).toContain("max-md:hidden");
  });

  it("says plain Filters when none is set, and 筛选 (n) in Chinese", () => {
    const { unmount } = renderBarWithUnmount("");
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent(/^Filters$/);
    unmount();
    renderBar("?minScore=60&minSalary=70000", "zh");
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("筛选 (2)");
  });

  it("opens the filters as a sheet, closes with the close button, Done and Escape", async () => {
    renderBar();
    const toggle = screen.getByTestId("filter-toggle");
    const panel = screen.getByTestId("filter-panel");

    await userEvent.click(toggle);
    expect(panel).toHaveAttribute("data-open", "true");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel.className).toContain("max-md:fixed");

    await userEvent.click(screen.getByTestId("filter-close"));
    expect(panel).toHaveAttribute("data-open", "false");

    await userEvent.click(toggle);
    await userEvent.click(screen.getByTestId("filter-apply"));
    expect(panel).toHaveAttribute("data-open", "false");

    await userEvent.click(toggle);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(panel).toHaveAttribute("data-open", "false"));
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});

function renderBarWithUnmount(searchParams: string) {
  const Adapter = withNuqsTestingAdapter({ searchParams });
  return render(
    <Adapter>
      <NextIntlClientProvider locale="en" messages={en}>
        <FilterBar options={options} />
      </NextIntlClientProvider>
    </Adapter>,
  );
}


describe("FilterBar: multi-select filters", () => {
  const optionOf = (testId: string, value: string) => {
    const option = screen.getAllByTestId(`${testId}-option`).find((o) => o.getAttribute("data-value") === value);
    if (!option) throw new Error(`no option ${value}`);
    return option;
  };
  const pick = async (testId: string, value: string) => {
    await userEvent.click(screen.getByTestId(testId));
    const option = screen.getAllByTestId(`${testId}-option`).find((o) => o.getAttribute("data-value") === value);
    if (!option) throw new Error(`no option ${value}`);
    await userEvent.click(option);
  };

  it("two picks in a row make one URL update with repeated keys, and the page goes back to 1", async () => {
    // The quiet time is a real timer inside nuqs. On a loaded machine two picks can land more than that apart and
    // make two updates, so the clock is faked: time only moves when the test moves it.
    vi.useFakeTimers();
    // Testing Library only drains its own timers under fake clocks when it sees a `jest` global
    Object.assign(globalThis, { jest: { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) } });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { onUrlUpdate, lastQuery } = renderBar("?page=3");
      const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

      await user.click(screen.getByTestId("filter-city"));
      await user.click(optionOf("filter-city", "Berlin"));
      // MultiSelect computes the next list from the committed value: let the first pick commit before the second
      await settle();
      expect(optionOf("filter-city", "Berlin")).toHaveAttribute("aria-checked", "true");
      await user.click(optionOf("filter-city", "München"));
      await settle();
      // the button already shows both; the URL waits for the quiet time
      expect(screen.getByTestId("filter-city")).toHaveTextContent("Berlin +1");
      expect(onUrlUpdate).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(lastQuery()).toBe("?city=Berlin&city=München");
      expect(onUrlUpdate).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(globalThis, "jest");
      vi.useRealTimers();
    }
  });

  it("closing the popover sends the pick at once", async () => {
    const { lastQuery } = renderBar();
    await pick("filter-source", "linkedin");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(lastQuery()).toBe("?source=linkedin"), { timeout: 300 });
  });

  it("offers the work-place values in canonical order and writes enum picks in that order", async () => {
    const { lastQuery } = renderBar();
    await pick("filter-workplace", "remote");
    await waitFor(() => expect(optionOf("filter-workplace", "remote")).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(optionOf("filter-workplace", "onsite"));
    await waitFor(() => expect(optionOf("filter-workplace", "onsite")).toHaveAttribute("aria-checked", "true"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(lastQuery()).toBe("?workplace=onsite&workplace=remote"));
  });

  it("shows an old bookmark's value that no job has as a selected, marked option", async () => {
    renderBar("?city=Gone&city=Berlin");
    expect(screen.getByTestId("filter-city")).toHaveTextContent("Gone +1");
    await userEvent.click(screen.getByTestId("filter-city"));
    const first = screen.getAllByTestId("filter-city-option")[0] as HTMLElement;
    expect(first).toHaveAttribute("data-value", "Gone");
    expect(first).toHaveAttribute("aria-checked", "true");
    expect(first).toHaveTextContent("no jobs now");
  });

  it("reads an old single-value link the same as before: one selected city", () => {
    renderBar("?city=Berlin&source=ats&workplace=remote");
    expect(screen.getByTestId("filter-city")).toHaveTextContent("Berlin");
    expect(screen.getByTestId("filter-source")).toHaveAttribute("aria-label", "Source: Company ATS");
    expect(screen.getByTestId("filter-workplace")).toHaveTextContent("remote");
  });

  it("lists every picked value as a chip; the x removes just that one", async () => {
    const { lastQuery } = renderBar("?city=Berlin&city=M%C3%BCnchen&workplace=remote");
    const chips = screen.getAllByTestId("filter-chip");
    expect(chips.map((c) => c.textContent)).toEqual(["City · Berlin×", "City · München×", "Workplace · remote×"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove filter City: Berlin" }));
    await waitFor(() => expect(lastQuery()).toBe("?workplace=remote&city=München"));
    await waitFor(() => expect(screen.getAllByTestId("filter-chip")).toHaveLength(2));
  });

  it("has no chip row without a picked value", () => {
    renderBar("?app=new&minScore=60");
    expect(screen.queryByTestId("filter-chips")).toBeNull();
  });

  it("counts a multi-select once in Filters (n) and Clear filters empties every list", async () => {
    const { lastQuery } = renderBar("?city=Berlin&city=M%C3%BCnchen&source=ats&source=xing&workplace=remote");
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("Filters (3)");
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe(""));
    await waitFor(() => expect(screen.queryByTestId("filter-chips")).toBeNull());
  });

  it("speaks Chinese: any, chips and the remove label", () => {
    renderBar("?city=Berlin", "zh");
    expect(screen.getByTestId("filter-source")).toHaveTextContent("全部");
    expect(screen.getByTestId("filter-chip")).toHaveTextContent("城市 · Berlin");
    expect(screen.getByRole("button", { name: "移除筛选 城市：Berlin" })).toBeInTheDocument();
  });
});

describe("FilterBar: company filter", () => {
  const companies = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Company ${String(i + 1).padStart(3, "0")}`, jobCount: n - i }));
  const shownValues = () => screen.getAllByTestId("filter-company-option").map((o) => o.getAttribute("data-value"));

  it("lists the companies in the given order with their job count next to the name; trigger and chip show the name only", async () => {
    const { lastQuery } = renderBar("", "en", { companies: [{ name: "Zalando", jobCount: 12 }, { name: "N26", jobCount: 3 }], companyOptionsCapped: false, companyOptionsVisible: 50 });
    await userEvent.click(screen.getByTestId("filter-company"));
    expect(shownValues()).toEqual(["Zalando", "N26"]);
    const zalando = screen.getAllByTestId("filter-company-option")[0] as HTMLElement;
    expect(within(zalando).getByText("Zalando")).toBeInTheDocument();
    expect(zalando.querySelector('[data-slot="option-count"]')).toHaveTextContent("12");
    await userEvent.click(zalando);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(lastQuery()).toBe("?company=Zalando"));
    await waitFor(() => {
      expect(screen.getByTestId("filter-company")).toHaveTextContent(/^Zalando$/);
      expect(screen.getByTestId("filter-chip")).toHaveTextContent(/^Company · Zalando×$/);
    });
    // no note: every company is listed
    expect(screen.queryByTestId("filter-company-note")).toBeNull();
  });

  it("draws only the first ones until something is typed, then searches all loaded ones", async () => {
    renderBar("", "en", { companies: companies(30), companyOptionsCapped: false, companyOptionsVisible: 5 });
    await userEvent.click(screen.getByTestId("filter-company"));
    expect(shownValues()).toEqual(["Company 001", "Company 002", "Company 003", "Company 004", "Company 005"]);
    expect(screen.getByTestId("filter-company-note")).toHaveTextContent("Showing 5 of 30 companies");
    await userEvent.type(screen.getByTestId("filter-company-search"), "027");
    await waitFor(() => expect(shownValues()).toEqual(["Company 027"]));
  });

  it("does not say capped when exactly the maximum companies exist", async () => {
    renderBar("", "en", { companies: companies(20), companyOptionsCapped: false, companyOptionsVisible: 20 });
    await userEvent.click(screen.getByTestId("filter-company"));
    expect(shownValues()).toHaveLength(20);
    expect(screen.queryByTestId("filter-company-note")).toBeNull();
  });

  it("says when more companies existed than the loaded maximum, and keeps a picked company outside the first ones drawn", async () => {
    renderBar("?company=Company%20020", "en", { companies: companies(20), companyOptionsCapped: true, companyOptionsVisible: 3 });
    await userEvent.click(screen.getByTestId("filter-company"));
    expect(shownValues()).toEqual(["Company 020", "Company 001", "Company 002", "Company 003"]);
    expect(screen.getByTestId("filter-company-note")).toHaveTextContent("the 20 companies with the most jobs");
  });

  it("shows a company of the URL that is not among the options as selected and marked, and counts it as a filter", async () => {
    renderBar("?company=Gone%20GmbH", "en", { companies: [{ name: "Zalando", jobCount: 1 }], companyOptionsCapped: false, companyOptionsVisible: 50 });
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("Filters (1)");
    expect(screen.getByTestId("filter-chip")).toHaveTextContent("Company · Gone GmbH");
    await userEvent.click(screen.getByTestId("filter-company"));
    const first = screen.getAllByTestId("filter-company-option")[0] as HTMLElement;
    expect(first).toHaveAttribute("data-value", "Gone GmbH");
    expect(first).toHaveAttribute("aria-checked", "true");
    expect(first).toHaveTextContent("no jobs now");
  });

  it("the chip's x removes the company, and Clear filters clears it", async () => {
    const { lastQuery } = renderBar("?company=Zalando&company=N26", "en", { companies: [{ name: "Zalando", jobCount: 2 }, { name: "N26", jobCount: 1 }] });
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Company: Zalando" }));
    await waitFor(() => expect(lastQuery()).toBe("?company=N26"));
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe(""));
  });

  it("speaks Chinese", async () => {
    renderBar("?company=Zalando", "zh", { companies: [{ name: "Zalando", jobCount: 2 }] });
    expect(screen.getByTestId("filter-chip")).toHaveTextContent("公司 · Zalando");
  });
});

describe("FilterBar: multi-select on a phone", () => {
  it("unfolds one list at a time inside the sheet", async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true, writable: true });
    try {
      renderBar("?city=Berlin");
      await userEvent.click(screen.getByTestId("filter-toggle"));
      expect(screen.queryAllByTestId("filter-city-option")).toHaveLength(0);
      await userEvent.click(screen.getByTestId("filter-city"));
      expect(screen.getAllByTestId("filter-city-option").length).toBeGreaterThan(0);
      await userEvent.click(screen.getByTestId("filter-workplace"));
      expect(screen.queryAllByTestId("filter-city-option")).toHaveLength(0);
      expect(screen.getAllByTestId("filter-workplace-option").length).toBe(4);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: original, configurable: true, writable: true });
    }
  });
});

describe("FilterBar: high-value signals only", () => {
  it("is hidden when no category is high value", () => {
    renderBar();
    expect(screen.queryByTestId("filter-high")).toBeNull();
  });

  it("names the high-value categories in its tooltip and writes `high`", async () => {
    const { lastQuery } = renderBar("", "en", { highValueNames: ["Explicit amount", "Equity"] });
    const button = screen.getByTestId("filter-high");
    expect(button).toHaveAttribute("title", "Only jobs with a high-value signal: Explicit amount / Equity");
    await userEvent.click(button);
    await waitFor(() => expect(lastQuery()).toBe("?high=true"));
  });

  it("reads an old `t12` link as on, and writes only `high` from then on", async () => {
    const { lastQuery } = renderBar("?t12=true", "en", { highValueNames: ["Equity"] });
    expect(screen.getByTestId("filter-high")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("filter-salary"));
    await waitFor(() => expect(screen.getByTestId("filter-salary")).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(lastQuery()).toBe("?high=true&salary=true"));
    await userEvent.click(screen.getByTestId("filter-high"));
    await waitFor(() => expect(lastQuery()).toBe("?salary=true"));
  });
});

describe("FilterBar: sort direction", () => {
  it("uses relevance for search text ahead of the archive default", () => {
    renderBar("?scope=archive&q=engineer&sort=invalid");
    expect(screen.getByTestId("filter-sort")).toHaveTextContent("Relevance");
    expect(screen.queryByTestId("filter-sort-dir")).not.toBeInTheDocument();
  });

  it.each([
    ["", "rank"],
    ["?scope=archive", "last_listed"],
    ["?q=AI", "relevance"],
    ["?scope=archive&q=AI", "relevance"],
  ])("omits the default sort for the current query and scope (%s)", async (query, defaultSort) => {
    const { lastQuery } = renderBar(query);
    const choose = async (value: string) => {
      await userEvent.click(screen.getByTestId("filter-sort"));
      await userEvent.click(screen.getAllByTestId("filter-sort-option").find((o) => o.getAttribute("data-value") === value)!);
    };
    await choose("salary");
    await waitFor(() => expect(new URLSearchParams(lastQuery()).get("sort")).toBe("salary"));
    if (query) {
      await choose("rank");
      await waitFor(() => expect(new URLSearchParams(lastQuery()).get("sort")).toBe("rank"));
    }
    await choose(defaultSort);
    await waitFor(() => expect(lastQuery()).toBe(query));
  });
  it("offers the salary sort next to the score and a new sort drops the direction", async () => {
    const { lastQuery } = renderBar("?sort=first_seen&dir=asc&page=2");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("filter-sort"));
    const options = await screen.findAllByTestId("filter-sort-option");
    expect(options.map((o) => o.getAttribute("data-value"))).toEqual(["rank", "salary", "first_seen", "posted", "last_listed"]);
    await user.click(options[1]!);
    await waitFor(() => expect(lastQuery()).toBe("?sort=salary"));
  });

  it("flips the direction with the button next to the drop-down and leaves the default out of the URL", async () => {
    const { lastQuery } = renderBar("?sort=salary&page=3");
    const user = userEvent.setup();
    const button = screen.getByTestId("filter-sort-dir");
    expect(button).toHaveAttribute("data-dir", "desc");
    expect(button).toHaveAccessibleName("Descending (highest first), click for ascending");
    await user.click(button);
    await waitFor(() => expect(lastQuery()).toBe("?sort=salary&dir=asc"));
    await waitFor(() => expect(screen.getByTestId("filter-sort-dir")).toHaveAttribute("data-dir", "asc"));
    await user.click(screen.getByTestId("filter-sort-dir"));
    await waitFor(() => expect(lastQuery()).toBe("?sort=salary"));
  });

  it("speaks Chinese", () => {
    renderBar("?sort=rank&dir=asc", "zh");
    expect(screen.getByTestId("filter-sort-dir")).toHaveAccessibleName("升序（低的在前），点击改为降序");
  });
});

describe("FilterBar: scope and reasons", () => {
  it.each(["?scope=archive", "?scope=all", "?status=closed"])("offers reasons outside resolved Current (%s)", async (query) => {
    renderBar(query);
    await userEvent.click(screen.getByTestId("filter-reason"));
    expect(screen.getAllByTestId("filter-reason-option").map((o) => o.getAttribute("data-value"))).toEqual(["manual", "gone", "dormant"]);
    expect(screen.getAllByTestId("filter-reason-option")[0]).toHaveTextContent("Closed by you");
  });

  it.each(["", "?scope=current&status=closed"])("hides the reason control in Current but keeps a removable chip (%s)", async (query) => {
    const { lastQuery } = renderBar(`${query}${query ? "&" : "?"}reason=gone`);
    expect(screen.queryByTestId("filter-reason")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter Reason: Taken down at the source" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Reason: Taken down at the source" }));
    await waitFor(() => expect(lastQuery()).toBe(query));
  });

  it("writes multiple reasons, and clear removes them and status while keeping scope", async () => {
    const { lastQuery } = renderBar("?scope=all&status=closed&page=2");
    await userEvent.click(screen.getByTestId("filter-reason"));
    for (const value of ["gone", "manual"]) {
      const option = screen.getAllByTestId("filter-reason-option").find((o) => o.getAttribute("data-value") === value)!;
      await userEvent.click(option);
      await waitFor(() => expect(option).toHaveAttribute("aria-checked", "true"));
    }
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(new URLSearchParams(lastQuery()).getAll("reason")).toEqual(["manual", "gone"]));
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe("?scope=all"));
  });
});

describe("FilterBar: seen-again readiness", () => {
  it("clears a ready seen-again filter while preserving scope", async () => {
    const { lastQuery } = renderBar("?scope=current&relisted=true", "en", { relisted: true });
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("Filters (1)");
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe("?scope=current"));
  });

  it("ignores an unavailable seen-again filter and keeps its URL value when clearing other filters", async () => {
    const { lastQuery } = renderBar("?scope=current&relisted=true&q=rust", "en", { relisted: false });
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent(/^Filters$/);
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe("?scope=current&relisted=true"));
  });
});

describe("search relevance and URL-only country", () => {
  it("offers relevance only with q, ignores asc, and restores direction controls on explicit rank", async () => {
    const { lastQuery } = renderBar("?q=AI&dir=asc");
    expect(screen.getByTestId("filter-sort")).toHaveTextContent("Relevance");
    expect(screen.queryByTestId("filter-sort-dir")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("filter-sort"));
    expect(screen.getAllByTestId("filter-sort-option").map((el) => el.getAttribute("data-value"))).toEqual(["relevance", "rank", "salary", "first_seen", "posted", "last_listed"]);
    await userEvent.click(screen.getAllByTestId("filter-sort-option").find((el) => el.getAttribute("data-value") === "rank")!);
    await waitFor(() => expect(lastQuery()).toBe("?q=AI&sort=rank"));
    await waitFor(() => expect(screen.getByTestId("filter-sort-dir")).toHaveAttribute("data-dir", "desc"));
    expect(screen.getByTestId("filter-sort")).toHaveTextContent("Rank value");
  });

  it("shows a localized country chip, removes it and preserves searchIn on clear", async () => {
    const { lastQuery } = renderBar("?country=PT&searchIn=all", "en", { countries: [{ code: "PT", jobCount: 0, name: "Portugal" }] });
    expect(screen.getByTestId("filter-chip")).toHaveTextContent("Country · Portugal");
    expect(screen.getByTestId("filter-country")).toBeInTheDocument();
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("Filters (1)");
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Country: Portugal" }));
    await waitFor(() => expect(lastQuery()).toBe("?searchIn=all"));
  });

  it("clear filters preserves search scope while removing countries", async () => {
    const { lastQuery } = renderBar("?country=PT&searchIn=all&q=AI");
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe("?searchIn=all"));
  });
});

describe("precise job search controls", () => {
  it("toggles description scope, resets pagination and keeps the scope on clear", async () => {
    const { lastQuery } = renderBar("?q=AI&page=3");
    const toggle = screen.getByTestId("filter-search-in");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("title", en.dashboard.jobs.filters.includeDescriptionsHint);
    await userEvent.click(toggle);
    await waitFor(() => expect(lastQuery()).toContain("searchIn=all"));
    expect(lastQuery()).not.toContain("page=");
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(lastQuery()).toBe("?searchIn=all"));
    await userEvent.click(toggle);
    await waitFor(() => expect(lastQuery()).toBe(""));
  });

  it("keeps the country picker open while selecting multiple countries", async () => {
    const { lastQuery } = renderBar("", "en", { countries: [{ code: "DE", jobCount: 2, name: "Germany" }, { code: "FR", jobCount: 1, name: "France" }] });
    await userEvent.click(screen.getByTestId("filter-country"));
    for (const code of ["DE", "FR"]) {
      const option = screen.getAllByTestId("filter-country-option").find((row) => row.dataset.value === code)!;
      await userEvent.click(option);
      await waitFor(() => expect(option).toHaveAttribute("aria-checked", "true"));
      expect(screen.getByTestId("filter-country")).toHaveAttribute("aria-expanded", "true");
    }
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(new URLSearchParams(lastQuery()).getAll("country")).toEqual(["DE", "FR"]));
  });

  it.each(["en", "zh"] as const)("labels country chips and counts in %s with the server's names, including absent selected countries", async (locale) => {
    // the server adds selected countries without jobs (count 0) and names every option in the interface language
    const portugalName = locale === "en" ? "Portugal" : "葡萄牙";
    renderBar("?country=PT", locale, { countries: [{ code: "DE", jobCount: 2, name: locale === "en" ? "Germany" : "德国" }, { code: "PT", jobCount: 0, name: portugalName }] });
    expect(screen.getByTestId("filter-chips")).toHaveTextContent(portugalName);
    await userEvent.click(screen.getByTestId("filter-country"));
    const portugal = screen.getAllByTestId("filter-country-option").find((o) => o.dataset.value === "PT");
    expect(portugal).toHaveTextContent(portugalName);
    expect(portugal?.querySelector('[data-slot="option-count"]')).toHaveTextContent("0");
    const germany = screen.getAllByTestId("filter-country-option").find((o) => o.dataset.value === "DE");
    expect(germany?.querySelector('[data-slot="option-count"]')).toHaveTextContent("2");
  });
});

describe("FilterBar: date filter", () => {
  // nuqs writes the keys in the order it saw them: compare as sets
  const sorted = (query: string) => [...new URLSearchParams(query)].map(([k, v]) => `${k}=${v}`).sort();
  const expectQuery = (lastQuery: () => string, expected: string) => waitFor(() => expect(sorted(lastQuery())).toEqual(sorted(expected)));
  const checked = (group: string) => within(screen.getByTestId(group)).queryAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent);
  const rangeLabels = () => within(screen.getByTestId("date-filter-range")).getAllByRole("radio").map((r) => r.textContent);

  it("offers the configured ranges between Any time and Custom…, and re-reads them when the list changes", () => {
    const first = renderBar("");
    expect(rangeLabels()).toEqual(["Any time", "Last 1 day", "Last 7 days", "Last 2 weeks", "This month", "Custom…"]);
    first.unmount();
    renderBar("", "en", { dateQuickRanges: ["3d", "30d"] });
    expect(rangeLabels()).toEqual(["Any time", "Last 3 days", "Last 30 days", "Custom…"]);
  });

  it("speaks Chinese", () => {
    renderBar("", "zh");
    expect(within(screen.getByTestId("date-filter-range")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["不限", "1 天内", "7 天内", "2 周内", "本月", "自定义…"]);
    expect(within(screen.getByTestId("date-filter-field")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["发布日期", "首次发现"]);
  });

  it("shows the configured date and Any time when nothing is set", () => {
    renderBar("");
    expect(checked("date-filter-field")).toEqual(["Posted date"]);
    expect(checked("date-filter-range")).toEqual(["Any time"]);
    expect(screen.queryByTestId("filter-from")).toBeNull();
  });

  it("shows the configured default date from ui.yaml", () => {
    renderBar("", "en", { dateDefaultField: "seen" });
    expect(checked("date-filter-field")).toEqual(["First seen"]);
  });

  it("reads an old from / to link as first seen, Custom…, with the dates in the boxes", () => {
    renderBar("?from=2026-10-01&to=2026-10-15");
    expect(checked("date-filter-field")).toEqual(["First seen"]);
    expect(checked("date-filter-range")).toEqual(["Custom…"]);
    expect(screen.getByTestId("filter-from")).toHaveValue("2026-10-01");
    expect(screen.getByTestId("filter-to")).toHaveValue("2026-10-15");
  });

  it("writes the range and the date it compares, and swaps dates for a range", async () => {
    const { lastQuery } = renderBar("?from=2026-10-01&to=2026-10-15&dateBy=seen&page=2");
    await userEvent.click(screen.getByTestId("date-filter-range-7d"));
    await expectQuery(lastQuery, "?within=7d&dateBy=seen");
    await waitFor(() => expect(screen.queryByTestId("filter-from")).toBeNull());
    await userEvent.click(screen.getByTestId("date-filter-field-posted"));
    await expectQuery(lastQuery, "?within=7d&dateBy=posted");
    await userEvent.click(screen.getByTestId("date-filter-range-month"));
    await expectQuery(lastQuery, "?within=month&dateBy=posted");
  });

  it("Custom… unfolds the boxes, a date clears the quick range, Any time clears everything", async () => {
    const { lastQuery } = renderBar("?within=7d&dateBy=posted");
    await userEvent.click(screen.getByTestId("date-filter-range-custom"));
    await expectQuery(lastQuery, "?dateBy=posted");
    expect(await screen.findByTestId("filter-from")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("filter-from"), { target: { value: "2026-10-01" } });
    await expectQuery(lastQuery, "?from=2026-10-01&dateBy=posted");
    fireEvent.change(screen.getByTestId("filter-to"), { target: { value: "2026-10-15" } });
    await expectQuery(lastQuery, "?from=2026-10-01&to=2026-10-15&dateBy=posted");
    await userEvent.click(screen.getByTestId("date-filter-range-any"));
    await expectQuery(lastQuery, "");
    expect(screen.queryByTestId("filter-from")).toBeNull();
  });

  it("a range that is not on the list still filters, highlights nothing and says so in its chip", () => {
    renderBar("?within=30d&dateBy=posted");
    expect(checked("date-filter-range")).toEqual([]);
    expect(screen.getByTestId("filter-chip")).toHaveTextContent("Posted · Last 30 days");
  });

  it("the range wins over dates in a hand-written link, and the next write drops the dates", async () => {
    const { lastQuery } = renderBar("?within=7d&from=2026-10-01&to=2026-10-15&dateBy=seen");
    expect(checked("date-filter-range")).toEqual(["Last 7 days"]);
    await userEvent.click(screen.getByTestId("filter-salary"));
    await expectQuery(lastQuery, "?within=7d&dateBy=seen&salary=true");
  });

  it("shows one chip per date condition, and its × clears the range, the dates and the date they compare", async () => {
    const posted = renderBar("?within=7d&dateBy=posted");
    expect(screen.getByTestId("filter-chip")).toHaveTextContent("Posted · Last 7 days");
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("Filters (1)");
    await userEvent.click(screen.getByRole("button", { name: "Remove date filter: Posted · Last 7 days" }));
    await expectQuery(posted.lastQuery, "");
  });

  it.each([
    ["?within=month&dateBy=seen", "First seen · This month"],
    ["?from=2026-10-01&to=2026-10-15&dateBy=posted", "Posted · 10-01 – 10-15"],
    ["?from=2026-10-01&to=2026-10-15", "First seen · 10-01 – 10-15"],
    ["?from=2025-12-20&to=2026-01-03&dateBy=seen", "First seen · 2025-12-20 – 2026-01-03"],
    ["?from=2026-10-01&dateBy=posted", "Posted · from 2026-10-01"],
    ["?to=2026-10-15&dateBy=seen", "First seen · until 2026-10-15"],
  ])("writes the chip of %s as %s", (query, text) => {
    renderBar(query);
    expect(screen.getByTestId("filter-chip")).toHaveTextContent(text);
  });

  it("a bare dateBy is no filter: no chip, not counted, the picked date still shows", () => {
    renderBar("?dateBy=seen");
    expect(screen.queryByTestId("filter-chip")).toBeNull();
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("Filters");
    expect(screen.getByTestId("filter-toggle")).not.toHaveTextContent("(");
    expect(checked("date-filter-field")).toEqual(["First seen"]);
  });

  it("counts the date condition once, whether it is a range or two dates", () => {
    renderBar("?from=2026-10-01&to=2026-10-15&dateBy=seen&minScore=60");
    expect(screen.getByTestId("filter-toggle")).toHaveTextContent("Filters (2)");
  });

  it("clear filters removes the range and the date they compare", async () => {
    const { lastQuery } = renderBar("?within=7d&dateBy=posted&minScore=60");
    await userEvent.click(screen.getByTestId("filter-clear"));
    await expectQuery(lastQuery, "");
  });

  it("folds the empty Custom… boxes when the filters are cleared or the chip is removed", async () => {
    renderBar("?minScore=60");
    await userEvent.click(screen.getByTestId("date-filter-range-custom"));
    expect(await screen.findByTestId("filter-from")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(screen.queryByTestId("filter-from")).toBeNull());
    expect(within(screen.getByTestId("date-filter-range")).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent)).toEqual(["Any time"]);
  });

  it("clear filters also removes a bare dateBy", async () => {
    const { lastQuery } = renderBar("?dateBy=seen&minScore=60");
    await userEvent.click(screen.getByTestId("filter-clear"));
    await expectQuery(lastQuery, "");
  });

  it("explains that jobs without a posted date use their first-seen date", () => {
    renderBar("");
    expect(screen.getByTestId("date-filter-field-posted")).toHaveAttribute("title", en.dashboard.jobs.filters.postedFallbackHint);
  });
});
