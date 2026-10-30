import {
  Briefcase,
  Building2,
  CalendarCheck,
  ChartColumn,
  Coins,
  KanbanSquare,
  ListChecks,
  Radar,
  Settings,
  ScrollText,
  Sparkles,
  Star,
  UserRound,
  type LucideIcon,
} from "lucide-react";

export type NavKey =
  | "today"
  | "jobs"
  | "companies"
  | "favorites"
  | "pipeline"
  | "sources"
  | "insights"
  | "settings"
  | "me"
  | "interests";

/** `main` items first; the last three belong under the "// 设置" label. */
export type NavGroup = "main" | "settings";

export interface NavItem {
  /** Key under `nav.*` and `pages.*` in the messages files. */
  key: NavKey;
  href: string;
  icon: LucideIcon;
  group: NavGroup;
}

/** Single source of truth for sidebar, mobile sheet and command palette. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "today", href: "/", icon: CalendarCheck, group: "main" },
  { key: "jobs", href: "/jobs", icon: Briefcase, group: "main" },
  { key: "companies", href: "/companies", icon: Building2, group: "main" },
  { key: "favorites", href: "/favorites", icon: Star, group: "main" },
  { key: "pipeline", href: "/pipeline", icon: KanbanSquare, group: "main" },
  { key: "sources", href: "/sources", icon: Radar, group: "main" },
  { key: "insights", href: "/insights", icon: ChartColumn, group: "main" },
  { key: "settings", href: "/settings", icon: Settings, group: "settings" },
  { key: "me", href: "/me", icon: UserRound, group: "settings" },
  { key: "interests", href: "/interests", icon: Sparkles, group: "settings" },
];

/** Pages under a main item that the command palette also lists (labels: `sources.subnav.*`). The sidebar shows only the main items. */
export const PALETTE_SUBPAGES = [
  { key: "registry", href: "/sources/registry", icon: ListChecks },
  { key: "aiUsage", href: "/sources/ai-usage", icon: Coins },
  { key: "logs", href: "/sources/logs", icon: ScrollText },
] as const;

/** `/` only matches exactly; other items also match their sub-routes (e.g. /jobs/123). */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The nav items in display order, split into the groups the sidebar shows (the order inside and across groups is `NAV_ITEMS`). */
export function groupNavItems(items: readonly NavItem[] = NAV_ITEMS): { group: NavGroup; items: NavItem[] }[] {
  return (["main", "settings"] as const)
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);
}
