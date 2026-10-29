import { pointerWithin, rectIntersection, type ClientRect, type CollisionDetection, type KeyboardCoordinateGetter, type UniqueIdentifier } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vitest";

import { boardCollisions, revealInBoard, zoneCoordinates } from "@/components/pipeline/board-scroll";
import { clipRect, revealDelta, revealZoneDelta, visibleCollisions } from "@/components/pipeline/geometry";
import { EagerKeyboardSensor } from "@/components/pipeline/keyboard-sensor";

type Args = Parameters<CollisionDetection>[0];
type Container = Args["droppableContainers"][number];
const rect = (left: number, top: number, width: number, height: number): ClientRect => ({ left, top, width, height, right: left + width, bottom: top + height });
const container = (id: string, box: ClientRect, node: HTMLElement | null = null): Container => ({ id, key: id, disabled: false, data: { current: {} }, rect: { current: box }, node: { current: node } });
function args(boxes: Array<[string, ClientRect]>, pointerCoordinates: Args["pointerCoordinates"] = null, collisionRect = rect(0, 0, 200, 200)): Args {
  return {
    active: { id: "card", data: { current: {} }, rect: { current: { initial: collisionRect, translated: collisionRect } } },
    collisionRect, pointerCoordinates,
    droppableRects: new Map(boxes),
    droppableContainers: boxes.map(([id, box]) => container(id, box)),
  };
}

describe("visible board collisions", () => {
  it("clips against both axes and all ancestors, rejecting empty and touching intersections", () => {
    expect(clipRect(rect(0, 0, 300, 500), [rect(50, 40, 200, 300), rect(80, 100, 100, 400)])).toEqual(rect(80, 100, 100, 240));
    expect(clipRect(rect(0, 0, 100, 100), [rect(100, 0, 100, 100)])).toBeNull();
    expect(clipRect(rect(0, 0, 100, 100), [rect(0, 101, 100, 100)])).toBeNull();
  });

  it.each([99, 301])("ignores pointer y=%s outside the visible zone even while the card overlaps it", (y) => {
    const input = args([["applied", rect(0, 0, 200, 800)]], { x: 100, y }, rect(0, y - 80, 200, 200));
    const clips = new Map([["applied", [rect(0, 100, 200, 200)]]]);
    expect(pointerWithin(input)[0]?.id).toBe("applied");
    expect(rectIntersection(input)[0]?.id).toBe("applied");
    expect(visibleCollisions(input, clips, null)).toEqual([]);
    expect(visibleCollisions({ ...input, pointerCoordinates: { x: 100, y: 150 } }, clips, null)[0]?.id).toBe("applied");
  });

  it("returns the selected keyboard zone only while visible, and clears stale selections", () => {
    const input = args([["applied", rect(0, 0, 200, 400)], ["rejected", rect(250, 0, 200, 48)]]);
    const clips = new Map(input.droppableContainers.map(({ id }) => [id, [rect(0, 0, 200, 200)]]));
    expect(visibleCollisions(input, clips, "applied")).toEqual([{ id: "applied" }]);
    expect(visibleCollisions(input, clips, "rejected")).toEqual([]);
    expect(visibleCollisions(input, clips, null)).toEqual([]);
  });

  it("keeps rejected selected for a tall card spanning all three collapsed ended zones", () => {
    const input = args([["rejected", rect(0, 0, 200, 48)], ["withdrawn", rect(0, 48, 200, 48)], ["archived", rect(0, 96, 200, 48)]], null, rect(0, 30, 200, 200));
    expect(rectIntersection(input)[0]?.id).toBe("withdrawn");
    expect(visibleCollisions(input, new Map(), "rejected")).toEqual([{ id: "rejected" }]);
  });

  it("does not reset an already visible target or a zone spanning the viewport", () => {
    expect(revealDelta(110, 160, 100, 200)).toBe(0);
    expect(revealDelta(-400, 500, 100, 200)).toBe(0);
    expect(revealDelta(100, 500, 100, 200)).toBe(0);
    expect(revealDelta(50, 120, 100, 200)).toBe(-50);
    expect(revealDelta(150, 250, 100, 200)).toBe(50);
    expect(revealZoneDelta(100, 500, 100, 200)).toBe(0);
    expect(revealZoneDelta(190, 500, 100, 200)).toBe(0);
    expect(revealZoneDelta(-50, 110, 100, 200)).toBe(0);
    expect(revealZoneDelta(250, 300, 100, 200)).toBe(100);
  });
});

class Containers extends Map<UniqueIdentifier, Container> {
  override get(id: UniqueIdentifier | null | undefined) { return id == null ? undefined : super.get(id); }
  toArray() { return [...this.values()]; }
  getEnabled() { return this.toArray().filter((zone) => !zone.disabled); }
  getNodeFor(id: UniqueIdentifier | null | undefined) { return this.get(id)?.node.current ?? undefined; }
}

it("reveals a clipped landing at its column's snap start so snap cannot hide the card again", () => {
  const board = document.createElement("div");
  const column = document.createElement("section");
  column.dataset.testid = "board-column";
  const card = document.createElement("div");
  board.append(column);
  column.append(card);
  Object.defineProperties(board, { clientWidth: { value: 200 }, clientHeight: { value: 200 } });
  vi.spyOn(board, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 200));
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue(new DOMRect(150, 0, 100, 200));
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 10, 80, 100));
  board.scrollTo = vi.fn();
  revealInBoard(card, board);
  expect(board.scrollTo).toHaveBeenCalledWith({ left: 150, behavior: "instant" });
});

it("keyboard navigation scrolls offscreen columns and groups before measuring, without scrolling main or resetting a visible group", () => {
  const board = document.createElement("div");
  const scroll = document.createElement("div");
  scroll.dataset.columnScroll = "";
  const zone = document.createElement("div");
  scroll.append(zone);
  board.append(scroll);
  document.body.append(board);
  for (const node of [board, scroll]) Object.defineProperties(node, { clientWidth: { value: 200 }, clientHeight: { value: 200 } });
  vi.spyOn(board, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 200, 200));
  vi.spyOn(scroll, "getBoundingClientRect").mockImplementation(() => new DOMRect(400 - board.scrollLeft, 0, 200, 200));
  vi.spyOn(zone, "getBoundingClientRect").mockImplementation(() => new DOMRect(400 - board.scrollLeft, 500 - scroll.scrollTop, 200, 48));
  board.scrollTo = vi.fn((options?: ScrollToOptions | number) => { if (typeof options === "object") board.scrollLeft = options.left ?? board.scrollLeft; });
  scroll.scrollTo = vi.fn((options?: ScrollToOptions | number) => { if (typeof options === "object") scroll.scrollTop = options.top ?? scroll.scrollTop; });
  const target = container("withdrawn", rect(400, 500, 200, 48), zone);
  const input = args([["withdrawn", target.rect.current!]]);
  input.droppableContainers = [target];
  const selected: { current: UniqueIdentifier | null } = { current: null };
  const context: Parameters<KeyboardCoordinateGetter>[1] = {
    active: "card", currentCoordinates: { x: 0, y: 0 },
    context: {
      active: input.active, activeNode: null, activatorEvent: null, collisions: [], collisionRect: input.collisionRect,
      draggableNodes: new Map(), draggingNode: null, draggingNodeRect: null, droppableRects: input.droppableRects,
      droppableContainers: new Containers([["withdrawn", target]]), over: null, scrollableAncestors: [], scrollAdjustedTranslate: null,
    },
  };
  expect(boardCollisions(input, board, "withdrawn")).toEqual([]);
  const next = zoneCoordinates(board, selected)(new KeyboardEvent("keydown", { code: "ArrowRight" }), context);
  expect(board.scrollTo).toHaveBeenCalledWith({ left: 400, behavior: "instant" });
  expect(scroll.scrollTo).toHaveBeenCalledWith({ top: 348, behavior: "instant" });
  expect(next).toEqual({ x: 1, y: 153 });
  expect(boardCollisions(input, board, selected.current)).toEqual([{ id: "withdrawn" }]);
  vi.mocked(scroll.scrollTo).mockClear();
  zoneCoordinates(board, selected)(new KeyboardEvent("keydown", { code: "ArrowRight" }), context);
  expect(scroll.scrollTo).not.toHaveBeenCalled();
  expect(scroll.scrollTop).toBe(348);
  board.remove();
});

it("the real keyboard sensor leaves the old column and main still after the getter reveals the previous zone", () => {
  const board = document.createElement("div");
  const source = document.createElement("div");
  const target = document.createElement("div");
  const active = document.createElement("div");
  source.dataset.columnScroll = "";
  source.append(active);
  board.append(target, source);
  document.body.append(board);
  Object.defineProperties(source, { clientWidth: { value: 200 }, clientHeight: { value: 500 }, scrollWidth: { value: 200 }, scrollHeight: { value: 3000 } });
  Object.defineProperties(board, { clientWidth: { value: 600 }, clientHeight: { value: 700 } });
  vi.spyOn(board, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 700));
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue(new DOMRect(250, 200, 200, 500));
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 200, 200, 500));
  vi.spyOn(active, "getBoundingClientRect").mockReturnValue(new DOMRect(250, 500, 200, 200));
  source.scrollTop = 1000;
  source.scrollBy = vi.fn((options?: ScrollToOptions | number) => { if (typeof options === "object") source.scrollTop += options.top ?? 0; });
  board.scrollBy = vi.fn();
  const input = args([["preparing", rect(10, 200, 200, 500)], ["applied", rect(250, -800, 200, 3000)]], null, rect(250, 500, 200, 200));
  const context: Parameters<KeyboardCoordinateGetter>[1]["context"] = {
    active: input.active, activeNode: active, activatorEvent: null, collisions: [], collisionRect: input.collisionRect,
    draggableNodes: new Map(), draggingNode: active, draggingNodeRect: input.collisionRect, droppableRects: input.droppableRects,
    droppableContainers: new Containers([["preparing", container("preparing", rect(10, 200, 200, 500), target)], ["applied", container("applied", rect(250, -800, 200, 3000), source)]]),
    over: null, scrollableAncestors: [source, board], scrollAdjustedTranslate: null,
  };
  const selected: { current: UniqueIdentifier | null } = { current: "applied" };
  new EagerKeyboardSensor({
    active: "card", activeNode: { id: "card", key: "card", data: { current: {} }, node: { current: active }, activatorNode: { current: active } },
    event: new KeyboardEvent("keydown", { code: "Space" }), context: { current: context },
    options: { coordinateGetter: zoneCoordinates(board, selected), scrollBehavior: "instant" },
    onAbort: vi.fn(), onPending: vi.fn(), onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn(),
  });
  try {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowUp", cancelable: true }));
    expect(selected.current).toBe("preparing");
    expect(source.scrollTop).toBe(1000);
    expect(source.scrollBy).not.toHaveBeenCalled();
    expect(board.scrollBy).not.toHaveBeenCalled();
    expect(context.scrollableAncestors).toEqual([source, board]);
  } finally {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    board.remove();
  }
});
