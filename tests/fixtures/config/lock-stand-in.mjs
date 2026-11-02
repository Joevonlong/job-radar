// Preload for config commands run as child processes without a database. The slot is the one `write-lock.ts` reads.
globalThis[Symbol.for("job-radar.config-write-lock-provider")] = async () => ({
  acquired: true,
  lock: { fence: async () => true, release: async () => {} },
});
