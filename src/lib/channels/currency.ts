const SYMBOLS: Readonly<Record<string, string>> = {
  "€": "EUR",
  "$": "USD",
  "£": "GBP",
  "zł": "PLN",
  "kč": "CZK",
};

/**
 * A currency as a source writes it ("€", "$", "eur", "EUR") -> its ISO 4217 code, or null when it is
 * neither a known symbol nor a three-letter code (C3: nothing is guessed).
 */
export function currencyCodeOf(value: string | null | undefined): string | null {
  const token = value?.trim();
  if (!token) return null;
  const symbol = SYMBOLS[token.toLowerCase()];
  if (symbol) return symbol;
  return /^[A-Za-z]{3}$/.test(token) ? token.toUpperCase() : null;
}
