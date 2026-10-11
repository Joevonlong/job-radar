import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import "./viz.css";
import { cx } from "./util";

export interface TickerItem {
  key: string;
  /** Short amber prefix: `NEW`, `RUN`, `SRC`. */
  tag?: string;
  text: ReactNode;
  /** Green emphasis after the text (a salary, a score). */
  accent?: ReactNode;
}

export interface TickerProps {
  items: readonly TickerItem[];
  /** Most items scrolled (`ui.yaml: ticker_max_items`); the first ones are kept, so pass the newest first. Default: all. */
  maxItems?: number;
  className?: string;
}

function renderItems(items: readonly TickerItem[]): ReactNode {
  return items.map((item) => (
    <span key={item.key}>
      {item.tag ? <b>{item.tag}</b> : null} {item.text}
      {item.accent ? (
        <>
          {" · "}
          <em>{item.accent}</em>
        </>
      ) : null}
    </span>
  ));
}

/** Terminal strip that scrolls what just happened. Only for live places; pauses on hover. The list is doubled for a seamless loop (the copy is hidden from assistive technology). */
export function Ticker({ items, maxItems, className }: TickerProps) {
  const t = useTranslations("viz");
  const shown = maxItems === undefined ? items : items.slice(0, maxItems);
  return (
    <div className={cx("jr jr-ticker", shown.length === 0 && "jr-ticker--static", className)} role="group" aria-label={t("ticker.aria")}>
      <span className="jr-ticker__lb">{t("ticker.live")}</span>
      {shown.length === 0 ? (
        <span className="jr-ticker__in">{t("ticker.empty")}</span>
      ) : (
        <div className="jr-ticker__in">
          {renderItems(shown)}
          <span aria-hidden style={{ display: "contents" }}>
            {renderItems(shown.map((item) => ({ ...item, key: `${item.key}-copy` })))}
          </span>
        </div>
      )}
    </div>
  );
}
