"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type Ref } from "react";

import { cn } from "@/lib/utils";

/** One text line is this tall (rem): the gutter, the highlight bars and the textarea share it, so line numbers stay lined up. */
const LINE_HEIGHT_REM = 1.375;
const INDENT = "  ";

export interface YamlTextareaHandle {
  /** Move the cursor to `line:col` (1-based), scroll it into view and focus the box. */
  jumpTo: (line: number, col: number) => void;
}

interface YamlTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** 1-based lines with a problem: their number and background are red. */
  errorLines: ReadonlySet<number>;
  /** Cmd / Ctrl + S. */
  onSave: () => void;
  ariaLabel: string;
  ariaDescribedBy?: string;
  /** Accessible hint about the Tab key (Escape, then Tab moves on). */
  tabHint: string;
  ref?: Ref<YamlTextareaHandle>;
}

/** Offset of the first character of line `line` (1-based) in `text`. */
export function offsetOfLine(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

/** Indent (or, with `outdent`, unindent) every line the selection touches by two spaces; returns the new text and selection. */
export function shiftLines(text: string, start: number, end: number, outdent: boolean): { text: string; start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lastLineStart = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const blockEndIndex = text.indexOf("\n", lastLineStart);
  const blockEnd = blockEndIndex === -1 ? text.length : blockEndIndex;
  const block = text.slice(lineStart, blockEnd).split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const shifted = block.map((line, index) => {
    if (!outdent) {
      if (index === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
      return INDENT + line;
    }
    const remove = line.startsWith(INDENT) ? INDENT.length : line.startsWith(" ") ? 1 : 0;
    if (index === 0) firstDelta = -remove;
    totalDelta -= remove;
    return line.slice(remove);
  });
  return {
    text: text.slice(0, lineStart) + shifted.join("\n") + text.slice(blockEnd),
    start: Math.max(lineStart, start + firstDelta),
    end: Math.max(lineStart, end + totalDelta),
  };
}

/**
 * A plain textarea with line numbers (no editor library). Fixed line height, no wrapping. Tab indents by two spaces (Shift+Tab
 * unindents; Escape, then Tab, leaves the box for keyboard users), Cmd / Ctrl+S asks to save, lines with a problem are red, and
 * `jumpTo` puts the cursor on a given line. The gutter and the red bars follow the scrolling of the box without re-rendering.
 */
export function YamlTextarea({ value, onChange, errorLines, onSave, ariaLabel, ariaDescribedBy, tabHint, ref }: YamlTextareaProps) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const escaped = useRef(false);
  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const longest = useMemo(() => value.split("\n").reduce((max, line) => Math.max(max, line.length), 0), [value]);

  useImperativeHandle(ref, () => ({
    jumpTo: (line, col) => {
      const area = areaRef.current;
      if (!area) return;
      const offset = Math.min(value.length, offsetOfLine(value, line) + Math.max(0, col - 1));
      area.focus({ preventScroll: true });
      area.setSelectionRange(offset, offset);
      const lineHeightPx = parseFloat(getComputedStyle(area).lineHeight) || 22;
      // two lines of context above the target
      area.scrollTop = Math.max(0, (line - 3) * lineHeightPx);
      syncScroll();
    },
  }));

  function syncScroll() {
    const area = areaRef.current;
    if (!area) return;
    const shift = `translateY(${-area.scrollTop}px)`;
    if (gutterRef.current) gutterRef.current.style.transform = shift;
    if (barsRef.current) barsRef.current.style.transform = shift;
  }

  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const area = areaRef.current;
    if (selection && area) {
      area.setSelectionRange(selection.start, selection.end);
      pendingSelection.current = null;
    }
  });
  useEffect(() => syncScroll(), [value]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
      return;
    }
    if (event.key === "Escape") {
      escaped.current = true;
      return;
    }
    if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) {
      escaped.current = false;
      return;
    }
    // Escape, then Tab: let the browser move the focus (no keyboard trap)
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    event.preventDefault();
    const area = event.currentTarget;
    const { selectionStart: start, selectionEnd: end } = area;
    if (start === end && !event.shiftKey) {
      pendingSelection.current = { start: start + INDENT.length, end: start + INDENT.length };
      onChange(value.slice(0, start) + INDENT + value.slice(end));
      return;
    }
    const next = shiftLines(value, start, end, event.shiftKey);
    pendingSelection.current = { start: next.start, end: next.end };
    onChange(next.text);
  }

  const lh = `${LINE_HEIGHT_REM}rem`;
  const lines = useMemo(() => Array.from({ length: lineCount }, (_, index) => index + 1), [lineCount]);
  return (
    <div className="border-border bg-card flex h-[min(34rem,70vh)] overflow-hidden rounded-card border-bw font-mono text-data" data-testid="yaml-editor">
      <div aria-hidden className="bg-soft text-ink-3 border-border w-12 shrink-0 overflow-hidden border-r-bw py-2 text-right select-none">
        <div ref={gutterRef} style={{ lineHeight: lh }}>
          {lines.map((line) => (
            <div key={line} className={cn("pr-2", errorLines.has(line) && "bg-bad text-on-bad font-bold")} data-line-error={errorLines.has(line) ? "true" : undefined}>
              {line}
            </div>
          ))}
        </div>
      </div>
      <div className="relative min-w-0 flex-1">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden py-2">
          <div ref={barsRef} className="relative" style={{ height: `calc(${lineCount} * ${lh})` }}>
            {[...errorLines].map((line) => (
              <div key={line} className="bg-bad/15 absolute inset-x-0" style={{ top: `calc(${line - 1} * ${lh})`, height: lh }} />
            ))}
          </div>
        </div>
        <textarea
          ref={areaRef}
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          wrap="off"
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={errorLines.size > 0 || undefined}
          data-testid="yaml-textarea"
          title={tabHint}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          style={{ lineHeight: lh, minWidth: `${Math.min(longest + 4, 400)}ch` }}
          className="text-ink absolute inset-0 size-full resize-none overflow-auto bg-transparent px-3 py-2 whitespace-pre outline-none"
        />
      </div>
    </div>
  );
}
