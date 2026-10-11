export interface ScoreMetaInput {
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  /** When it was scored, already formatted for the viewer. */
  when: string | null;
}

export interface ScoreMetaLabels {
  by: (provider: string) => string;
  model: (model: string) => string;
  prompt: (version: string) => string;
}

const known = (value: string | null): value is string => value !== null && value.trim() !== "";

/**
 * "Scored by codex-cli · gpt-5 · prompt v3 · 2026/10/8 05:42": only the parts that are known (C3: no "?" placeholders),
 * a model that only repeats the provider left out. Null when nothing is known, so the line is not drawn.
 */
export function scoreMetaText(input: ScoreMetaInput, labels: ScoreMetaLabels): string | null {
  const parts: string[] = [];
  if (known(input.provider)) parts.push(labels.by(input.provider.trim()));
  if (known(input.model) && input.model.trim() !== input.provider?.trim()) parts.push(labels.model(input.model.trim()));
  if (known(input.promptVersion)) parts.push(labels.prompt(input.promptVersion.trim()));
  if (known(input.when)) parts.push(input.when.trim());
  return parts.length > 0 ? parts.join(" · ") : null;
}
