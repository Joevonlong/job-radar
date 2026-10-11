import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge has to know the design-system v3 utilities from globals.css, otherwise `text-h1` is read as a
 * text colour (and drops `text-ink-2`), `border-bw` as a border colour, and `h-ctl-md` never replaces `h-9`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "num-xxl",
        "num-xl",
        "num-l",
        "num-m",
        "num-s",
        "h1",
        "h1-detail",
        "h2",
        "title",
        "title-sm",
        "body",
        "body-sm",
        "label",
        "cap",
        "data",
        "data-sm",
      ],
      color: [
        "paper",
        "card-bg",
        "ink",
        "ink-2",
        "ink-3",
        "grid",
        "soft",
        "hi",
        "hi-ink",
        "meter",
        "shadow-c",
        "good",
        "warn",
        "bad",
        "on-bad",
        "on-signal",
        "term-bg",
        "term-ink",
        "term-amber",
        "term-green",
        "term-dim",
        "term-bad",
        "term-line",
      ],
      spacing: [
        "sp-1",
        "sp-2",
        "sp-3",
        "sp-4",
        "sp-5",
        "sp-6",
        "sp-8",
        "sp-10",
        "sp-14",
        "ctl-sm",
        "ctl-md",
        "ctl-lg",
      ],
      radius: ["cell", "tag", "btn", "card", "frame", "pill"],
      shadow: ["e1", "e2", "e3", "e4", "e5", "e2-bad", "drawer"],
      ease: ["snap", "spring"],
    },
    classGroups: {
      "border-w": [{ border: ["bw"] }],
      "border-w-x": [{ "border-x": ["bw"] }],
      "border-w-y": [{ "border-y": ["bw"] }],
      "border-w-s": [{ "border-s": ["bw"] }],
      "border-w-e": [{ "border-e": ["bw"] }],
      "border-w-t": [{ "border-t": ["bw"] }],
      "border-w-r": [{ "border-r": ["bw"] }],
      "border-w-b": [{ "border-b": ["bw"] }],
      "border-w-l": [{ "border-l": ["bw"] }],
      z: [{ z: ["sticky", "dropdown", "drawer", "modal", "toast", "tooltip"] }],
      duration: [{ duration: ["press", "fast", "base", "slow", "count"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
