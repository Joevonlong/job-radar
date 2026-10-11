/**
 * Converting between currencies through the pivot of pipeline.yaml (`salary.fx_pivot` + `fx_rates`): the rate
 * of a currency is how many units of the pivot one unit of it is worth (the pivot's own rate is 1). From X to the base
 * currency the factor is `rate(X) / rate(base)`. With the pivot as base this is `rate(X)` itself, bit for bit what the
 * EUR-only table did before. A currency without a rate is not converted (C3: no invented rates).
 */
export interface FxTable {
  fx_pivot: string;
  fx_rates: Readonly<Record<string, number>>;
}

function rateOf(currency: string, fx: FxTable): number | undefined {
  return currency === fx.fx_pivot ? 1 : fx.fx_rates[currency];
}

/** The factor that turns an amount in `from` into `base`; 1 for the same currency; null without a rate for either. */
export function fxFactor(from: string, base: string, fx: FxTable): number | null {
  if (from === base) return 1;
  const source = rateOf(from, fx);
  const target = rateOf(base, fx);
  if (source === undefined || target === undefined) return null;
  return target === 1 ? source : source / target;
}

/** Every currency convertible to `base` with this table, and the factor (rough rates of interests.yaml use the same shape). */
export function ratesToBase(base: string, fx: FxTable): Record<string, number> {
  const out: Record<string, number> = { [base]: 1 };
  for (const currency of [fx.fx_pivot, ...Object.keys(fx.fx_rates)]) {
    const factor = fxFactor(currency, base, fx);
    if (factor !== null) out[currency] = factor;
  }
  return out;
}
