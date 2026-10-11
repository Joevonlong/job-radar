"use client";

/**
 * Motion foundation of the data-viz library (docs/design/tokens.md "动效"). Everything that touches the
 * `motion` package lives in this one file, so the library can be swapped without touching a component.
 *
 * - `useReducedMotion`: the user's prefers-reduced-motion setting (false on the server).
 * - `usePlayOnView` / `PlayOnView`: a chart plays once, when it first scrolls into view; with reduced motion
 *   it is in its final state at once. The CSS in viz.css keys on `data-played="false" | "true"`.
 * - `LayoutGroup` / `Presence` / `VizMotionConfig`: thin wrappers over Motion for layout animations (rows flying
 *   to their new place when the sort changes) and exit animations (filtered rows leave before the list closes up).
 * - `useIsPresent`: false while a child of `Presence` plays its exit (it is still in the DOM, but no longer in the list).
 * (The steps() helpers `STEPS` / `stepStyle` live in util.ts: they run in server components too.)
 */
import { AnimatePresence, LayoutGroup as MotionLayoutGroup, MotionConfig, motion, useIsPresent as useMotionIsPresent } from "motion/react";
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./util";

// ---------------------------------------------------------------- reduced motion

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function reducedSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}

/** True when the user asked for less motion. Server render: false (the CSS media query covers the first paint). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, reducedSnapshot, () => false);
}

// ---------------------------------------------------------------- play on view

/** How long a replay rests in the start state before it plays again. */
const REPLAY_GAP_MS = 80;

export interface PlayOnViewOptions {
  /** Share of the element that must be visible before it plays. */
  threshold?: number;
}

export interface PlayOnView<T extends HTMLElement> {
  ref: (node: T | null) => void;
  /** False until the element has been in view once (and, with reduced motion, never false after mount). */
  played: boolean;
  /** Back to the start state, then play again (the "重播" button of the dev page). */
  replay: () => void;
}

function subscribeNothing(): () => void {
  return () => undefined;
}

/** Can this browser tell us when an element is visible? (The server assumes yes, so server and first client render agree.) */
function useCanObserve(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => typeof IntersectionObserver !== "undefined",
    () => true,
  );
}

export function usePlayOnView<T extends HTMLElement = HTMLElement>({ threshold = 0.3 }: PlayOnViewOptions = {}): PlayOnView<T> {
  const reduced = useReducedMotion();
  const canObserve = useCanObserve();
  const [element, setElement] = useState<T | null>(null);
  const [seen, setSeen] = useState(false);
  const [hold, setHold] = useState(false);
  const timer = useRef<number | null>(null);
  // No motion to wait for (or no way to know the element is visible): the final state, at once.
  const played = reduced || !canObserve || seen;

  useEffect(() => {
    if (played || hold || element === null) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, played, hold, threshold]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const replay = useCallback(() => {
    setSeen(false);
    setHold(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    // Stay in the start state for a moment, so the CSS animations restart from the beginning.
    timer.current = window.setTimeout(() => setHold(false), REPLAY_GAP_MS);
  }, []);

  return { ref: setElement, played, replay };
}

type PlayOnViewTag = "span" | "div";

export interface PlayOnViewProps extends HTMLAttributes<HTMLElement> {
  as?: PlayOnViewTag;
  threshold?: number;
  children?: ReactNode;
}

/**
 * Wrapper element that carries `data-played`. Server components render their markup inside it, so only this
 * small element is a client component: the charts themselves stay server-renderable.
 */
export function PlayOnView({ as = "span", threshold, className, children, ...rest }: PlayOnViewProps) {
  const { ref, played } = usePlayOnView<HTMLElement>(threshold === undefined ? {} : { threshold });
  return createElement(as, { ...rest, ref, className: cx("jr", className), "data-played": played ? "true" : "false" }, children);
}

// ---------------------------------------------------------------- Motion wrappers

/** Respect the user's reduced-motion setting for every Motion animation below it. */
export function VizMotionConfig({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** Elements inside share layout animations: a row whose position changes flies to its new place. */
export function LayoutGroup({ id, children }: { id?: string; children: ReactNode }) {
  return <MotionLayoutGroup {...(id === undefined ? {} : { id })}>{children}</MotionLayoutGroup>;
}

/** Children that leave the tree play their `exit` animation first. `initial={false}`: no entrance on first render. */
export function Presence({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

/**
 * Inside a direct child of `Presence`: true while it is in the tree, false while it plays its exit animation. A leaving
 * element stays in the DOM until its exit has finished (a frame-driven animation, so it can take longer on a busy
 * machine); use this to take it out of the list's semantics at once.
 */
export function useIsPresent(): boolean {
  return useMotionIsPresent();
}

/** `motion.div` etc., re-exported so pages import Motion from this file only. */
export { motion };

/**
 * Transition of a sliding indicator (Segmented, tabs): the `--dur-base` time with the `--ease-spring` curve of
 * docs/design/tokens.md. With reduced motion the indicator jumps (no slide).
 */
export function slideTransition(reduced: boolean): { duration: number; ease: [number, number, number, number] } {
  return { duration: reduced ? 0 : 0.22, ease: [0.34, 1.56, 0.64, 1] };
}
