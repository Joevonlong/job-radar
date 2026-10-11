/** How `pnpm run setup` talks to the terminal (scripts/setup.ts) or to a test. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Ask one question; resolves with the typed line (null at the end of the input). */
  ask(question: string): Promise<string | null>;
  /** Ask for a secret: what is typed is not echoed (falls back to `ask` when missing, e.g. piped input). */
  askSecret?(question: string): Promise<string | null>;
  /** Aborted on Ctrl-C / SIGTERM: long waits stop, and the command cleans up (e.g. starts a runner it stopped). */
  signal?: AbortSignal;
}
