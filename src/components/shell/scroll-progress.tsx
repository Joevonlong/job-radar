/**
 * A thin amber bar at the top of the page that grows as the page scrolls. Pure CSS (scroll-driven animation,
 * globals.css `.scroll-progress`): browsers without `animation-timeline` never show it. Decorative, so hidden from
 * assistive tech.
 */
export function ScrollProgress() {
  return <div aria-hidden data-testid="scroll-progress" className="scroll-progress pointer-events-none fixed inset-x-0 top-0 z-dropdown h-[var(--bw)] bg-term-amber" />;
}
