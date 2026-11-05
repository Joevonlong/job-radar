import type { Resume } from "./schema";
import type { i18n } from "./i18n";

type L10n = ReturnType<typeof i18n>;

export type FontRef = {
  family: "Inter" | "Newsreader" | "IBM Plex Sans" | "IBM Plex Mono";
  weight: number;
};

export type Ctx = Omit<L10n, "t"> & {
  t: { [K in keyof L10n["t"]]: string };
  photoUrl?: string;
  signatureUrl?: string;
  today: string;
};

export interface Theme {
  fonts: FontRef[];
  render(r: Resume, ctx: Ctx): string;
  letter?(r: Resume, ctx: Ctx): string;
}
