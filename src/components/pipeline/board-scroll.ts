import type { ClientRect, CollisionDetection, KeyboardCoordinateGetter, UniqueIdentifier } from "@dnd-kit/core";

import { clipRect, revealDelta, revealZoneDelta, visibleCollisions } from "./geometry";

/** The client area excludes borders and native scrollbars. */
function viewportOf(node: HTMLElement): ClientRect {
  const rect = node.getBoundingClientRect();
  const left = rect.left + node.clientLeft;
  const top = rect.top + node.clientTop;
  return { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight, width: node.clientWidth, height: node.clientHeight };
}

function clipsOf(node: HTMLElement, board: HTMLElement): ClientRect[] {
  const scroll = node.closest<HTMLElement>("[data-column-scroll]");
  return scroll ? [viewportOf(scroll), viewportOf(board)] : [viewportOf(board)];
}

/** Reveal a zone or a landed card without ever scrolling main or the document. Instant also honours reduced motion. */
export function revealInBoard(node: HTMLElement, board: HTMLElement, { zone = false }: { zone?: boolean } = {}): void {
  const delta = zone ? revealZoneDelta : revealDelta;
  const rect = node.getBoundingClientRect();
  const viewport = viewportOf(board);
  const dx = delta(rect.left, rect.right, viewport.left, viewport.right);
  if (dx) {
    // Landing and Tab focus happen with snap enabled. Align the column's snap start so a small right-edge reveal
    // cannot snap back and hide the card again. During a drag, the zone getter uses the minimal visible movement.
    const column = !zone && node.closest<HTMLElement>('[data-testid="board-column"]');
    const offset = column ? column.getBoundingClientRect().left - viewport.left : dx;
    board.scrollTo({ left: board.scrollLeft + offset, behavior: "instant" });
  }
  const scroll = node.closest<HTMLElement>("[data-column-scroll]");
  if (!scroll) return;
  const columnViewport = viewportOf(scroll);
  const dy = delta(rect.top, rect.bottom, columnViewport.top, columnViewport.bottom);
  if (dy) scroll.scrollTo({ top: scroll.scrollTop + dy, behavior: "instant" });
}

/** Live rectangles matter after synchronous keyboard scrolling: dnd-kit's cached measurements are a frame behind. */
export function boardCollisions(args: Parameters<CollisionDetection>[0], board: HTMLElement | null, keyboardTarget: UniqueIdentifier | null): ReturnType<CollisionDetection> {
  if (!board) return [];
  const rects = new Map<UniqueIdentifier, ClientRect>();
  const clips = new Map<UniqueIdentifier, readonly ClientRect[]>();
  for (const container of args.droppableContainers) {
    const node = container.node.current;
    if (!node) continue;
    rects.set(container.id, node.getBoundingClientRect());
    clips.set(container.id, clipsOf(node, board));
  }
  return visibleCollisions({ ...args, droppableRects: rects }, clips, keyboardTarget);
}

/** All enabled zones participate in reading order, including columns and ended groups currently out of view. */
export function zoneCoordinates(board: HTMLElement | null, selected: { current: UniqueIdentifier | null }): KeyboardCoordinateGetter {
  return (event, { context: { droppableContainers, collisionRect, over } }) => {
    const forward = event.code === "ArrowRight" || event.code === "ArrowDown";
    const backward = event.code === "ArrowLeft" || event.code === "ArrowUp";
    if (!forward && !backward) return undefined;
    event.preventDefault();
    if (!board || !collisionRect) return undefined;
    const zones = droppableContainers.getEnabled().flatMap((container) => {
      const node = container.node.current;
      return node ? [{ id: container.id, node, rect: node.getBoundingClientRect() }] : [];
    }).sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
    const current = zones.findIndex((zone) => zone.id === (selected.current ?? over?.id));
    const next = zones[current < 0 ? (forward ? 0 : zones.length - 1) : Math.min(zones.length - 1, Math.max(0, current + (forward ? 1 : -1)))];
    if (!next) return undefined;
    revealInBoard(next.node, board, { zone: true });
    const visible = clipRect(next.node.getBoundingClientRect(), clipsOf(next.node, board));
    selected.current = visible ? next.id : null;
    return visible ? { x: visible.left + 1, y: visible.top + 1 } : undefined;
  };
}
