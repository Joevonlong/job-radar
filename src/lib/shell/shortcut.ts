/** Platform-aware shortcut labels: the command key on Apple platforms, Ctrl everywhere else. One place for every shortcut hint. */
export type ModifierLabel = "⌘" | "Ctrl";

/** The token a hint list uses for "the platform's modifier key"; `resolveKeyLabel` turns it into the real label. */
export const MOD_KEY = "Mod";

/** Pure: Mac, iPhone and iPad report an Apple platform string (or user agent); anything else (or nothing) is Ctrl. */
export function modifierFor(platform: string | null | undefined): ModifierLabel {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "") ? "⌘" : "Ctrl";
}

/** `Mod` becomes the platform's modifier label, any other key cap stays as written. */
export function resolveKeyLabel(key: string, modifier: ModifierLabel): string {
  return key === MOD_KEY ? modifier : key;
}
