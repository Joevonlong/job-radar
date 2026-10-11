/**
 * Class of an inline text link on the paper surface (docs/design/tokens.md: text is always ink, never the yellow): ink text,
 * underlined, the yellow only as the highlight under the pointer. The focus ring is the global one (`:focus-visible` in globals.css: 3px t4, 2px offset): do not add `outline-none` here, Tailwind turns it into `outline-style: none` and the ring disappears. The `link` button variant looks the
 * same. `text-primary` is the yellow itself (1.44:1 on white): never use it for text.
 */
export const INK_LINK = "text-ink rounded-[2px] font-medium underline decoration-2 underline-offset-4 hover:bg-hi hover:text-hi-ink";
