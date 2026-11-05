import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { PlacesField } from "@/components/profile/places-field";
import type { PlaceGeo } from "@/lib/market/places";
import type { PlaceDraft } from "@/lib/profile/draft";

import en from "../../messages/en.json";

const geo: PlaceGeo = {
  cityAliases: {},
  cities: { amsterdam: ["Amsterdam", "NL"] },
  countries: [{ code: "NL", name: "Netherlands", aliases: [] }],
  regions: { eu: { name: "European Union", countries: ["NL"] } },
};
const options = [{ value: "NL", label: "Netherlands", group: "countries" as const }];

function Harness({ initial = [], known = true, onChange = () => {} }: { initial?: PlaceDraft[]; known?: boolean; onChange?: (next: PlaceDraft[]) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <PlacesField id="places" value={value} geo={geo} options={options} known={known} onChange={(next) => { setValue(next); onChange(next); }} />
    </NextIntlClientProvider>
  );
}

async function add(text: string): Promise<void> {
  await userEvent.setup().type(document.getElementById("places") as HTMLElement, `${text}{Enter}`);
}

describe("PlacesField", () => {
  it("starts a city as a place to move to, a country or region as remote only", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await add("Amsterdam");
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amsterdam", relocate: true }]);
    await add("netherlands");
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amsterdam", relocate: true }, { place: "NL", relocate: false }]);
    await add("European Union");
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Amsterdam", relocate: true }, { place: "NL", relocate: false }, { place: "eu", relocate: false }]);
  });

  it("keeps an unknown name and warns about it, instead of refusing", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await add("Atlantis");
    expect(onChange).toHaveBeenLastCalledWith([{ place: "Atlantis", relocate: true }]);
    expect(screen.getByTestId("places-unknown")).toHaveTextContent("Atlantis");
  });

  it("does not warn when the tables are not the market the save will use", () => {
    render(<Harness initial={[{ place: "Atlantis", relocate: true }]} known={false} />);
    expect(screen.queryByTestId("places-unknown")).toBeNull();
  });

  it("does not add a place twice in another spelling", async () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ place: "NL", relocate: false }]} onChange={onChange} />);
    await add("Netherlands");
    expect(onChange).not.toHaveBeenCalled();
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
