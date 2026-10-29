import { pointerWithin, type ClientRect, type CollisionDetection, type UniqueIdentifier } from "@dnd-kit/core";

/** The visible part of a rectangle; touching edges do not form a drop target. */
export function clipRect(rect: ClientRect, clips: readonly ClientRect[]): ClientRect | null {
  const left = Math.max(rect.left, ...clips.map((clip) => clip.left));
  const top = Math.max(rect.top, ...clips.map((clip) => clip.top));
  const right = Math.min(rect.right, ...clips.map((clip) => clip.right));
  const bottom = Math.min(rect.bottom, ...clips.map((clip) => clip.bottom));
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}

/** Scroll the smallest distance needed. A target spanning the viewport is already visible. */
export function revealDelta(start: number, end: number, viewportStart: number, viewportEnd: number): number {
  if (start <= viewportStart && end >= viewportEnd) return 0;
  if (start < viewportStart) return start - viewportStart;
  if (end > viewportEnd) return end - viewportEnd;
  return 0;
}

/** A drop zone only needs a visible part for the keyboard's inset point; preserve any existing intersection. */
export function revealZoneDelta(start: number, end: number, viewportStart: number, viewportEnd: number): number {
  return end > viewportStart && start < viewportEnd ? 0 : revealDelta(start, end, viewportStart, viewportEnd);
}

/** Mouse hits use only the pointer. Keyboard hits use the selected zone, never the dragged card's area. */
export function visibleCollisions(
  args: Parameters<CollisionDetection>[0],
  clips: ReadonlyMap<UniqueIdentifier, readonly ClientRect[]>,
  keyboardTarget: UniqueIdentifier | null,
): ReturnType<CollisionDetection> {
  const droppableRects = new Map<UniqueIdentifier, ClientRect>();
  for (const container of args.droppableContainers) {
    const rect = args.droppableRects.get(container.id);
    const visible = rect && clipRect(rect, clips.get(container.id) ?? []);
    if (!container.disabled && visible) droppableRects.set(container.id, visible);
  }
  if (args.pointerCoordinates) return pointerWithin({ ...args, droppableRects });
  return keyboardTarget !== null && droppableRects.has(keyboardTarget) ? [{ id: keyboardTarget }] : [];
}
