"use client";

import { Pin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";

import "./jobs.css";

export interface ViewTab {
  key: string;
  label: string;
  href: string;
  active: boolean;
  isDefault: boolean;
  /** Jobs the view shows today, when known (the count next to the name). */
  count?: number;
}

/**
 * The view switch of Today: "all" and the saved views as a segmented control. The view is in the URL (each segment knows its href), so it survives a
 * reload; it scrolls sideways on a narrow screen, the page itself does not.
 */
export function ViewTabs({ tabs }: { tabs: ViewTab[] }) {
  const t = useTranslations("interests.today");
  const router = useRouter();
  const active = tabs.find((tab) => tab.active)?.key ?? "";
  // a row that scrolls sideways fades out at the edge that still has content behind it: the cut-off last item reads as "more here"
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = Math.ceil(Math.abs(el.scrollLeft)) + el.clientWidth < el.scrollWidth - 1;
    setFade((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure, tabs]);
  return (
    <div
      ref={scroller}
      onScroll={measure}
      className="jb-tabs -mx-1 max-w-full overflow-x-auto px-1 pt-px pb-sp-2"
      data-fade-start={fade.start ? "true" : undefined}
      data-fade-end={fade.end ? "true" : undefined}
      data-testid="view-tabs-scroll"
    >
      <Segmented
        aria-label={t("label")}
        value={active}
        onValueChange={(key) => {
          const tab = tabs.find((candidate) => candidate.key === key);
          if (tab) router.replace(tab.href);
        }}
        data-testid="view-tabs"
      >
        {tabs.map((tab) => (
          <SegmentedItem key={tab.key} value={tab.key} data-testid={`view-tab-${tab.key}`} data-active={tab.active} {...(tab.count === undefined ? {} : { count: tab.count })}>
            {tab.label}
            {tab.isDefault ? <Pin aria-label={t("default")} className="size-3 fill-current" /> : null}
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  );
}
