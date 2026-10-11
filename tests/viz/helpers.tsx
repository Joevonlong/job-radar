import { render, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

/** Render with the app messages (`zh` by default). */
export function renderViz(node: ReactElement, locale: "zh" | "en" = "zh"): RenderResult {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      {node}
    </NextIntlClientProvider>,
  );
}

export const AXIS = { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" } as const;
