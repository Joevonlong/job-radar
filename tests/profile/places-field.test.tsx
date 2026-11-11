import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePlaceGeo } from "@/components/profile/place-picker";
import { PlacesField } from "@/components/profile/places-field";
import type { Place as Geoname } from "@/lib/market/geo/dictionary";
import type { PlaceGeo } from "@/lib/market/places";
import type { PlaceDraft } from "@/lib/profile/draft";

import en from "../../messages/en.json";
import { candidate, geoname, stubPlaceSearch } from "./place-search-stub";

const base: PlaceGeo = {
  cityAliases: {},
  cities: { amsterdam: ["Amsterdam", "NL"] },
  countries: [{ code: "NL", name: "Netherlands", aliases: [] }],
  regions: { eu: { name: "European Union", countries: ["NL"] } },
};
const options = [
  { value: "eu", label: "European Union", group: "regions" as const },
  { value: "NL", label: "Netherlands", group: "countries" as const },
];
const AMSTERDAM = geoname(2759794, "city", "Amsterdam", "NL", "Netherlands", "North Holland");
const AMSTELVEEN = geoname(2759661, "city", "Amstelveen", "NL", "Netherlands", "North Holland");
const NETHERLANDS = geoname(2750405, "country", "Netherlands", "NL", "Netherlands");
const BERLIN = geoname(2950159, "city", "Berlin", "DE", "Germany", "Land Berlin");
const SAVED: Geoname[] = [];

function Harness({ initial = [], known = true, onChange = () => {} }: { initial?: PlaceDraft[]; known?: boolean; onChange?: (next: PlaceDraft[]) => void }) {
  const [value, setValue] = useState(initial);
  const { geo, remember } = usePlaceGeo(base, SAVED);
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <PlacesField
        id="places"
        value={value}
        geo={geo}
        onPick={remember}
        options={options}
        known={known}
        search={{ homeCity: "Berlin", homeCityId: BERLIN.id, workplace: ["onsite", "remote"], home: { country: "DE", countryName: "Germany" } }}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </NextIntlClientProvider>
  );
}

const input = () => screen.getByTestId("places-input");

async function pick(text: string, keys = "{Enter}"): Promise<void> {
  const user = userEvent.setup();
  await user.clear(input());
  await user.type(input(), text);
  await screen.findAllByRole("option");
  await user.keyboard(keys);
}

let requests: URLSearchParams[] = [];
beforeEach(() => {
  ({ requests } = stubPlaceSearch([candidate(AMSTERDAM), candidate(AMSTELVEEN), candidate(NETHERLANDS, "NL"), candidate(BERLIN)]));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PlacesField", () => {
  it("asks the dictionary in the page's language and lists the region and country of each city", async () => {
    render(<Harness />);
    await userEvent.setup().type(input(), "Ams");
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["AmsterdamNorth Holland, Netherlands", "AmstelveenNorth Holland, Netherlands"]);
    expect(requests.at(-1)?.get("lang")).toBe("en");
    expect(requests.at(-1)?.get("kinds")).toBe("any");
  });

  it("does not offer the home city", async () => {
    render(<Harness />);
    await userEvent.setup().type(input(), "Berl");
    expect(await screen.findByText(/No known place starts with this/)).toBeInTheDocument();
  });

  it("starts a city as a place to move to, a country or region as remote only, each with its id", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await pick("Amsterdam");
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amsterdam", relocate: true, id: AMSTERDAM.id }]);
    await pick("nether");
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amsterdam", relocate: true, id: AMSTERDAM.id }, { place: "NL", relocate: false, id: NETHERLANDS.id }]);
    await pick("European");
    expect(onChange).toHaveBeenLastCalledWith([
      { place: "Amsterdam", relocate: true, id: AMSTERDAM.id },
      { place: "NL", relocate: false, id: NETHERLANDS.id },
      { place: "eu", relocate: false, id: "eu" },
    ]);
  });

  it("picks with the arrow keys and closes the list with Escape", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await pick("Ams", "{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amstelveen", relocate: true, id: AMSTELVEEN.id }]);
    await userEvent.setup().type(input(), "Ams");
    await screen.findAllByRole("option");
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  it("picks with a click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), "Ams");
    await user.click(await screen.findByRole("option", { name: /Amstelveen/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amstelveen", relocate: true, id: AMSTELVEEN.id }]);
    expect(screen.getByRole("button", { name: /^Amstelveen:/ })).toBeInTheDocument();
  });

  it("adds nothing typed that is not picked", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.type(input(), "Atlantis");
    await screen.findByText(/No known place starts with this/);
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a saved name nothing knows and asks to pick it again", () => {
    render(<Harness initial={[{ place: "Atlantis", relocate: true }]} />);
    expect(screen.getByTestId("places-unknown")).toHaveTextContent("Atlantis");
    expect(screen.getByTestId("places-unknown")).toHaveTextContent("pick the place again");
  });

  it("does not warn when the tables are not the market the save will use", () => {
    render(<Harness initial={[{ place: "Atlantis", relocate: true }]} known={false} />);
    expect(screen.queryByTestId("places-unknown")).toBeNull();
  });

  it("does not offer a place again that is saved in another spelling", async () => {
    render(<Harness initial={[{ place: "NL", relocate: false }]} />);
    await userEvent.setup().type(input(), "Nether");
    expect(await screen.findByText(/No known place starts with this/)).toBeInTheDocument();
  });

  it("counts the searches a place adds per cycle, not its countries", () => {
    render(<Harness initial={[{ place: "Amsterdam", relocate: true }, { place: "NL", relocate: false }]} />);
    const counts = screen.getAllByTestId("place-searches").map((node) => node.textContent);
    expect(counts[0]).toContain("2");
    expect(counts[1]).toContain("1");
  });

  it("switches a place on a click; Worldwide stays remote only", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={[{ place: "Amsterdam", relocate: true }, { place: "Worldwide", relocate: false }]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /^Amsterdam:/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amsterdam", relocate: false }, { place: "Worldwide", relocate: false }]);
    expect(screen.getByRole("button", { name: "Worldwide: always remote only" })).toBeDisabled();
  });
});
