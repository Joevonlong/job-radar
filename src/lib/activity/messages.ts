import type { useTranslations } from "next-intl";

/** next-intl treats dots as paths. Keep all persisted codes in one reversible key convention. */
export function messageKey(code: string): string {
  return code.replaceAll(".", "__");
}

export type ActivityTranslator = ReturnType<typeof useTranslations<"activityLog">>;

/** Unknown/future codes never fall through to their database text. */
export function activityLabel(t: ActivityTranslator, group: string, code: string | null): string {
  const key = `${group}.${messageKey(code ?? "unknown")}`;
  if (t.has(key as never)) return t(key as never);
  if (group === "reason" && code !== null && t.has(`error.${messageKey(code)}` as never)) return t(`error.${messageKey(code)}` as never);
  return t(group === "error" || group === "reason" ? "error.other" : "unknown");
}
