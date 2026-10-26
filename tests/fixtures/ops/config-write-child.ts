/** Separate process using the real lowest-level writer; the first rename can be held by a file gate. */
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { atomicWrite } from "../../../src/lib/config/write";

const [file, text, record, gate] = process.argv.slice(2);
if (!file || !text || !record) throw new Error("missing fixture arguments");
if (process.env.CONFIG_WRITE_CLOCK_OFFSET_MS) {
  const realNow = Date.now.bind(Date);
  const offset = Number(process.env.CONFIG_WRITE_CLOCK_OFFSET_MS);
  Date.now = () => realNow() + offset;
}
// Force a stale-reclaimer interleaving at the actual unlink syscall; the writer and arbitration stay real.
if (process.env.CONFIG_WRITE_PAUSE_UNLINK && process.env.CONFIG_WRITE_RESUME_UNLINK) {
  const ready = process.env.CONFIG_WRITE_PAUSE_UNLINK;
  const resume = process.env.CONFIG_WRITE_RESUME_UNLINK;
  const unlink = fs.unlinkSync;
  let paused = false;
  fs.unlinkSync = (target) => {
    if (!paused && String(target).endsWith("/.write.lock")) {
      paused = true;
      fs.writeFileSync(ready, "");
      while (!fs.existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    unlink(target);
  };
}
if (process.env.CONFIG_WRITE_STARTED) fs.writeFileSync(process.env.CONFIG_WRITE_STARTED, "");
await atomicWrite(file, text, async () => {
  fs.appendFileSync(record, `${text}:enter\n`);
  while (gate && !fs.existsSync(gate)) await delay(10);
  fs.appendFileSync(record, `${text}:leave\n`);
});
