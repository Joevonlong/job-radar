// Changes the runtime before the release guard loads, for tests/integration/ai-worker-release.test.ts (--import it
// before the guard). RUNTIME_STUB selects what:
//   node=<version>       process.versions.node reports <version>
//   no-register-hooks    module.registerHooks is not there (an older Node)
import module from "node:module";

const stub = process.env.RUNTIME_STUB ?? "";
if (stub.startsWith("node=")) {
  Object.defineProperty(process.versions, "node", { value: stub.slice("node=".length), configurable: true, enumerable: true, writable: false });
} else if (stub === "no-register-hooks") {
  module.registerHooks = undefined;
} else {
  throw new Error(`runtime-stub.mjs: unknown RUNTIME_STUB "${stub}"`);
}
