import { cn } from "@/lib/utils";

/** Fills for the mark, from the signal / highlight tokens; the letters are `on-signal` (ink on every one of them, both themes). */
const FILLS = ["bg-hi", "bg-signal-t1", "bg-signal-t2", "bg-signal-t3", "bg-signal-t4", "bg-warn"] as const;

/** Two letters: the first letters of the first two words ("Quill Feather" -> "QF"), or the first two characters of one word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return "?";
  const second = words[1];
  const letters = second ? [...first].slice(0, 1).concat([...second].slice(0, 1)) : [...first].slice(0, 2);
  return letters.join("").toUpperCase();
}

/** The same company always gets the same fill. */
export function fillOf(name: string): (typeof FILLS)[number] {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return FILLS[hash % FILLS.length] ?? FILLS[0];
}

/** The company mark of a card (the design's `.logo`): a small rounded square with the initials. Decorative: the name is next to it. */
export function CompanyMark({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden data-slot="company-mark" className={cn("border-bw border-ink text-on-signal rounded-tag font-display text-cap inline-grid size-7 shrink-0 place-items-center leading-none", fillOf(name), className)}>
      {initialsOf(name)}
    </span>
  );
}
