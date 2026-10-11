import { AiProviderError } from "../errors";
import type { AiProviderId } from "../types";

/**
 * A counting semaphore with a limit that can change between calls (ai.yaml is hot-reloaded).
 * A waiter that is aborted leaves the queue and never takes a slot.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(public limit: number) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Resolves with a `release` function once a slot is free; rejects with an `aborted` error when `signal` fires first. */
  acquire(provider: AiProviderId, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new AiProviderError(provider, "aborted", "cancelled while waiting for a free slot"));
    return new Promise((resolve, reject) => {
      const take = (): void => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.drain();
        });
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(take);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new AiProviderError(provider, "aborted", "cancelled while waiting for a free slot"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(take);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < Math.max(1, this.limit)) {
      const next = this.waiting.shift();
      if (!next) return;
      next();
    }
  }
}
