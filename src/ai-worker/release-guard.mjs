// Resolution guard of the host ai-worker when it runs from a release directory
// (<main>/data/releases/ai-worker/<sha>/, built by scripts/ops/prepare-release.sh). The service definition loads it
// first: `node --import <release>/src/ai-worker/release-guard.mjs --import <release>/node_modules/tsx/dist/loader.mjs …`.
// Plain JavaScript with no dependencies (it runs before tsx); `pnpm ai-worker` from a checkout does not load it.
//
// Root: the release directory, i.e. two levels above this file, as a real path.
//
// Preconditions, checked before any hook is registered (so before tsx or any application code is loaded); each one
// that fails prints why and exits 1:
//   1. process.versions.node satisfies engines.node of <root>/package.json (scripts/ops/check-node-engines.mjs);
//   2. module.registerHooks exists (synchronous, in-thread module hooks);
//   3. no hooks thread: module.register is replaced by a function that exits 1, and syncBuiltinESMExports() makes the
//      named ESM export follow. tsx only takes the synchronous registerHooks path on the Node versions engines.node
//      allows; if it ever calls module.register (an older Node, a later tsx with other rules, a `.ts` --import before
//      it), the process stops before a loader thread exists, instead of running without this guard.
//   4. esbuild's platform package, found the way esbuild finds it from tsx (tsx -> esbuild -> @esbuild/<platform>-<arch>),
//      and its binary are inside the root; so is ESBUILD_BINARY_PATH when it is set. esbuild locates its binary with
//      require.resolve, which no hook sees.
//   5. no preload from outside the root: NODE_OPTIONS carries no --import, --require / -r, --loader or
//      --experimental-loader at all (the service definition never sets one; a value there would come from the user's
//      environment), and every such option on the command line (process.execArgv) names a file whose real path is
//      inside the root: this guard and tsx's loader in production; tests add their own fixtures from the release. Bare
//      package names are refused (the service definition uses absolute paths). A preload listed before this guard has
//      already run when the check happens; the check makes the process stop before any application code runs.
//
// What is guaranteed: in the worker's main thread, every resolution made through `import` or `require()` whose result
// lies outside the root (Node built-ins excepted) is refused before the module runs (registerHooks resolve hook:
// `node:` passes, a `file:` URL whose real path is inside the root passes, anything else throws). A load hook applies the
// same rule to every URL about to be loaded, as a second layer.
// Known exceptions:
//   - hooks registered later run first, and tsx registers after this guard: the resolve hook only sees what tsx's
//     resolve hook passes on through nextResolve, and the load hook only what tsx's load hook passes on through
//     nextLoad. A resolution tsx completes on its own reaches neither (the tests record that every module the worker
//     loads is inside the release);
//   - require.resolve() does not go through the hooks: esbuild's binary is checked explicitly above; for other packages
//     the audit recorded with the change that introduced this guard applies;
//   - worker_threads: hooks are per thread. The worker's own code starts no thread, but tsx calls esbuild's
//     transformSync, which starts a worker thread with `execArgv: []`, so this guard is not loaded there. That thread
//     only runs esbuild's JavaScript API, which talks to the binary checked in 4. (found by the same resolution, with
//     the same ESBUILD_BINARY_PATH); no way out of the release through it is known. A thread started later would not
//     be covered either.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import module, { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkNodeEngines } from "../../scripts/ops/check-node-engines.mjs";

const PREFIX = "release guard:";

function stop(message) {
  process.stderr.write(`${PREFIX} ${message}\n`);
  process.exit(1);
}

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const inRoot = (p) => p === root || p.startsWith(root + path.sep);

// 1. Node version
let range;
try {
  range = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))?.engines?.node;
} catch (error) {
  stop(`cannot read ${path.join(root, "package.json")}: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof range !== "string") stop(`${path.join(root, "package.json")} has no engines.node`);
const engines = checkNodeEngines(range, process.versions.node);
if (!engines.ok) stop(engines.message);

// 2. synchronous hooks
if (typeof module.registerHooks !== "function") {
  stop(`module.registerHooks is not available in Node ${process.versions.node}; install a Node that satisfies engines.node "${range}"`);
}

// 3. no hooks thread
module.register = () => {
  stop("tsx is not on the synchronous hooks path (module.register called)");
};
syncBuiltinESMExports();

// 4. esbuild's platform package and binary (names as in esbuild's install.js; only the Unix-like ones: macOS and Linux run the worker)
const ESBUILD_PLATFORM_PACKAGES = {
  "darwin arm64 LE": "@esbuild/darwin-arm64",
  "darwin x64 LE": "@esbuild/darwin-x64",
  "linux arm LE": "@esbuild/linux-arm",
  "linux arm64 LE": "@esbuild/linux-arm64",
  "linux ia32 LE": "@esbuild/linux-ia32",
  "linux x64 LE": "@esbuild/linux-x64",
  "linux loong64 LE": "@esbuild/linux-loong64",
  "linux mips64el LE": "@esbuild/linux-mips64el",
  "linux ppc64 LE": "@esbuild/linux-ppc64",
  "linux riscv64 LE": "@esbuild/linux-riscv64",
  "linux s390x BE": "@esbuild/linux-s390x",
  "freebsd arm64 LE": "@esbuild/freebsd-arm64",
  "freebsd x64 LE": "@esbuild/freebsd-x64",
};
const platformKey = `${process.platform} ${os.arch()} ${os.endianness()}`;
const platformPackage = ESBUILD_PLATFORM_PACKAGES[platformKey];
if (!platformPackage) stop(`no esbuild platform package is known for "${platformKey}"`);

function realInRoot(what, resolveIt) {
  let real;
  try {
    real = realpathSync(resolveIt());
  } catch (error) {
    stop(`cannot find ${what} from the release ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!inRoot(real)) stop(`${what} resolved to ${real}, outside ${root}`);
  return real;
}
const tsxPkg = realInRoot("tsx/package.json", () => path.join(root, "node_modules/tsx/package.json"));
const esbuildPkg = realInRoot("esbuild/package.json (from tsx)", () => createRequire(tsxPkg).resolve("esbuild/package.json"));
const platPkg = realInRoot(`${platformPackage}/package.json (from esbuild)`, () => createRequire(esbuildPkg).resolve(`${platformPackage}/package.json`));
const binary = path.join(path.dirname(platPkg), "bin", "esbuild");
if (!existsSync(binary)) stop(`the esbuild binary ${binary} does not exist`);
realInRoot("the esbuild binary", () => binary);
if (process.env.ESBUILD_BINARY_PATH) {
  realInRoot(`ESBUILD_BINARY_PATH (${process.env.ESBUILD_BINARY_PATH})`, () => process.env.ESBUILD_BINARY_PATH);
}

// 5. preloads
const PRELOAD_FLAGS = ["--import", "--require", "-r", "--loader", "--experimental-loader"];
const preloadFlagOf = (arg) => PRELOAD_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
const nodeOptions = process.env.NODE_OPTIONS ?? "";
const fromNodeOptions = nodeOptions.split(/\s+/).map((t) => t.replace(/^["']/, "")).find((t) => preloadFlagOf(t));
if (fromNodeOptions) {
  stop(`NODE_OPTIONS carries ${preloadFlagOf(fromNodeOptions)} (a preload from the environment); unset NODE_OPTIONS for the ai-worker`);
}
const execArgv = process.execArgv;
for (let i = 0; i < execArgv.length; i++) {
  const flag = preloadFlagOf(execArgv[i]);
  if (!flag) continue;
  const value = execArgv[i] === flag ? execArgv[++i] : execArgv[i].slice(flag.length + 1);
  if (!value) stop(`${flag} without a value`);
  let file;
  if (value.startsWith("file:")) file = fileURLToPath(value);
  else if (path.isAbsolute(value)) file = value;
  else if (value.startsWith("./") || value.startsWith("../")) file = path.resolve(process.cwd(), value);
  else stop(`${flag} ${value}: a preload must be given as a path inside ${root}, not as a package name`);
  realInRoot(`the preload ${flag} ${value}`, () => file);
}

// The hooks: accept only built-ins and real paths inside the root (resolve: after the next resolver; load: before it).
const allowed = new Map();
function urlInRoot(url) {
  if (url.startsWith("node:")) return true;
  if (!url.startsWith("file:")) return false;
  const known = allowed.get(url);
  if (known !== undefined) return known;
  let ok = false;
  try {
    ok = inRoot(realpathSync(fileURLToPath(url)));
  } catch {
    ok = false;
  }
  allowed.set(url, ok);
  return ok;
}
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (urlInRoot(result.url)) return result;
    throw new Error(`${PREFIX} ${specifier} resolved to ${result.url}, outside ${root}`);
  },
  load(url, context, nextLoad) {
    if (!urlInRoot(url)) throw new Error(`${PREFIX} refusing to load ${url}, outside ${root}`);
    return nextLoad(url, context);
  },
});
