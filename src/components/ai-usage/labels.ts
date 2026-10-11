import type { useTranslations } from "next-intl";

/** Name of an `ai_usage.task`: the translated one when `sources.ai.task.<task>` exists (a new task adds a key), else the raw value. */
export function taskLabel(t: ReturnType<typeof useTranslations<"sources.ai">>, task: string): string {
  return t.has(`task.${task}` as never) ? t(`task.${task}` as never) : task;
}
