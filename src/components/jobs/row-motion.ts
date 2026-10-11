/**
 * Motion of the list rows (docs/design/tokens.md "动效"): --dur-slow with the --ease-out curve; a row that leaves slides out to the
 * right while it fades (the rows below close up afterwards), a row that arrives fades in. With reduced motion `VizMotionConfig`
 * (reducedMotion="user") turns the movement off and the rows switch at once.
 */
export const ROW_TRANSITION = { duration: 0.36, ease: [0.16, 1, 0.3, 1] } as const;
export const ROW_ENTER = { opacity: 0, x: -10 } as const;
export const ROW_EXIT = { opacity: 0, x: 30 } as const;
