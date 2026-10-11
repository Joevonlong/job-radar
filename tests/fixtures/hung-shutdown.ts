// Child process for tests/ops/shutdown.test.ts: a worker whose shutdown never finishes.
import { installShutdown } from "../../src/lib/ops/shutdown";

const abort = new AbortController();
installShutdown({
  log: (m) => console.log(m),
  abort,
  graceMs: () => Number(process.env.GRACE_MS ?? "1000"),
  exit: (code) => process.exit(code),
});
setInterval(() => {}, 1000); // a handle that keeps the loop alive, like a pool or a watcher
console.log("ready");
if (process.env.THROW === "1") setTimeout(() => void Promise.reject(new Error("boom")), 50);
