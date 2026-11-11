const MAX_TOKENS = 600;

type Part = { kind: "same" | "removed" | "added"; text: string };

/** Word-level difference by longest common subsequence; long texts fall back to a whole before / after pair. */
export function wordDiff(before: string, after: string): Part[] {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [...(before ? [{ kind: "removed" as const, text: before }] : []), ...(after ? [{ kind: "added" as const, text: after }] : [])];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const parts: Part[] = [];
  const push = (kind: Part["kind"], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]!); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { push("removed", a[i]!); i++; }
    else { push("added", b[j]!); j++; }
  }
  while (i < a.length) push("removed", a[i++]!);
  while (j < b.length) push("added", b[j++]!);
  return parts;
}

export function ProposalDiff({ before, after, labels }: { before: string; after: string; labels: { removed: string; added: string } }) {
  return (
    <p className="min-w-0 whitespace-pre-wrap break-words" data-testid="proposal-diff">
      {wordDiff(before, after).map((part, index) =>
        part.kind === "same" ? <span key={index}>{part.text}</span>
          : part.kind === "removed" ? <del key={index} aria-label={labels.removed} className="bg-soft text-ink-2">{part.text}</del>
          : <ins key={index} aria-label={labels.added} className="bg-hi text-hi-ink no-underline">{part.text}</ins>,
      )}
    </p>
  );
}
