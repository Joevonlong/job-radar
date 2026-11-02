/**
 * Preloaded (`node --import`) into a real config command by tests/integration/ops/deploy-config-writes.test.ts, to stop it in
 * the middle of its writes: right after the first user file is published (so one file is new and the next still the original)
 * and inside the config write lock, it creates `$PAUSE_DIR/reached` and goes on once `$PAUSE_DIR/go` exists.
 *
 * Files in $PAUSE_DIR: `pid` (this process), `signals` (one line per INT, TERM or HUP it received, empty when none reached it),
 * `exit` (its exit code, when it ends normally). Stops waiting by itself after two minutes.
 */
import fs from "node:fs";
import path from "node:path";

const dir = process.env.PAUSE_DIR;
if (dir) {
  fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  fs.writeFileSync(path.join(dir, "signals"), "");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => fs.appendFileSync(path.join(dir, "signals"), `${signal}\n`));
  }
  process.on("exit", (code) => fs.writeFileSync(path.join(dir, "exit"), String(code)));

  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let paused = false;
  const pause = () => {
    if (paused) return;
    paused = true;
    fs.writeFileSync(path.join(dir, "reached"), "");
    const until = Date.now() + 120_000;
    while (!fs.existsSync(path.join(dir, "go")) && Date.now() < until) Atomics.wait(sleeper, 0, 0, 20);
  };
  const isUserFile = (file) => /[\\/]data[\\/](config|profile)[\\/][^\\/]+\.yaml$/.test(String(file));
  for (const name of ["renameSync", "linkSync"]) {
    const original = fs[name];
    fs[name] = (from, to) => {
      original(from, to);
      if (isUserFile(to)) pause();
    };
  }
}
