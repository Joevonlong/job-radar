/** Whether two city lists name the same places (case, order and repeats do not matter). Pure: the browser uses it too. */
export function sameLocations(a: readonly string[], b: readonly string[]): boolean {
  const key = (list: readonly string[]): string => [...new Set(list.map((x) => x.trim().toLowerCase()).filter((x) => x !== ""))].sort().join("\u0000");
  return key(a) === key(b);
}
