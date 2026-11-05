import type { Theme } from "../theme";
import minimal from "./minimal/template";
import { style as minimalStyle } from "./minimal/style";
import band from "./band/template";
import { style as bandStyle } from "./band/style";
import classic from "./classic/template";
import { style as classicStyle } from "./classic/style";
import compact from "./compact/template";
import { style as compactStyle } from "./compact/style";
import split from "./split/template";
import { style as splitStyle } from "./split/style";

export const THEMES: Readonly<Record<string, { template: Theme; style: string }>> = {
  minimal: { template: minimal, style: minimalStyle },
  band: { template: band, style: bandStyle },
  classic: { template: classic, style: classicStyle },
  compact: { template: compact, style: compactStyle },
  split: { template: split, style: splitStyle },
};
