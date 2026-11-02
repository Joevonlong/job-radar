/**
 * Stands between a host command and the database in the fresh-install test of tests/integration/ops/deploy-config-writes.test.ts:
 * until `<dir>/go` exists it accepts and counts connections and closes them at once, so "nothing reached the database before
 * the services started" is a number; after that it forwards to the real server.
 *
 *   node tcp-gate.mjs --target <host:port> --dir <directory> --ttl <seconds>
 *
 * Files in <dir>: `listening` (the port, written atomically), `count` (connections so far), `pre-up-count` (the count when
 * `go` appeared), `forwarding` (forwarding has begun). It stops by itself when its parent goes away or after --ttl seconds.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const option = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined) throw new Error(`tcp-gate: --${name} is required`);
  return value;
};

const separator = option("target").lastIndexOf(":");
const targetHost = option("target").slice(0, separator);
const targetPort = Number(option("target").slice(separator + 1));
const dir = option("dir");
const parent = process.ppid;

const writeAtomic = (name, text) => {
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(dir, name));
};

let count = 0;
let forwarding = false;

const server = net.createServer((socket) => {
  socket.on("error", () => {});
  if (!forwarding) {
    count += 1;
    writeAtomic("count", String(count));
    socket.destroy();
    return;
  }
  const upstream = net.connect(targetPort, targetHost);
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.pipe(upstream);
  upstream.pipe(socket);
});

server.listen(0, "127.0.0.1", () => writeAtomic("listening", String(server.address().port)));

setInterval(() => {
  if (forwarding || !fs.existsSync(path.join(dir, "go"))) return;
  writeAtomic("pre-up-count", String(count));
  forwarding = true;
  writeAtomic("forwarding", "");
}, 50);

// Never outlive the test: a gate left behind would keep a port and a route to the test database open.
setInterval(() => {
  let alive = process.ppid === parent;
  try {
    process.kill(parent, 0);
  } catch {
    alive = false;
  }
  if (!alive) process.exit(0);
}, 1000);
setTimeout(() => process.exit(0), Number(option("ttl")) * 1000);
