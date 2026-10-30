/** A country of the `/jobs` country filter with its name in the interface language. */
export interface NamedCountryOption {
  code: string;
  jobCount: number;
  name: string;
}

/**
 * Names the country options on the server. Node and the browser can ship different ICU data, so naming them in the
 * client could render one name on the server and another after hydration.
 */
export function withCountryNames(countries: readonly { code: string; jobCount: number }[], locale: string): NamedCountryOption[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return countries.map(({ code, jobCount }) => {
    let name: string | undefined;
    try {
      name = names.of(code);
    } catch {
      name = undefined;
    }
    return { code, jobCount, name: name ?? code };
  });
}
