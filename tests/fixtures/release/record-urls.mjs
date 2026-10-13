// Records every module resolution as the release guard sees it, for tests/integration/ai-worker-release.test.ts.
// Loaded with --import BEFORE the guard (it lives outside the release, so the guard would refuse it afterwards). Hooks
// registered later run first: the guard's resolve hook calls next, which reaches this one, so the file gets every URL
// the guard was asked to accept. One URL per line in RECORD_FILE.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const file = process.env.RECORD_FILE;
if (!file) throw new Error("record-urls.mjs: RECORD_FILE is not set");

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    appendFileSync(file, `${result.url}\n`);
    return result;
  },
});
