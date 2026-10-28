/** Merge concurrent calls by key. The first caller owns the work and its arguments; settlements allow a fresh retry. */
export function singleFlight<Key, Value>(): (key: Key, run: () => Promise<Value>) => Promise<Value> {
  const running = new Map<Key, Promise<Value>>();
  return (key, run) => {
    const existing = running.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(run).finally(() => { running.delete(key); });
    running.set(key, promise);
    return promise;
  };
}
