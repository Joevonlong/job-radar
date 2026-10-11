/**
 * pnpm run setup [--step <id>] [--answers <file.yaml>] [--status [--json]] [--complete] [--lang en|zh]
 * (`pnpm setup` alone is pnpm's own command.)
 *
 * The first-run setup on the command line (docs/setup.md): the same eight steps as the web wizard at /setup,
 * writing the same files. Interactive by default; `--answers` runs unattended, `--step` runs one step, `--status` only
 * prints where the setup stands, `--complete` marks it done without changing any configuration.
 * Exit codes: 0 done, 1 a step or the completion failed, 2 bad arguments or an unreadable answers file.
 */
import { createInterface } from "node:readline";

import { runSetupCli, type CliIo } from "../src/lib/setup/cli";

const lines: string[] = [];
const waiting: Array<(line: string | null) => void> = [];
let ended = false;

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
rl.on("line", (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else lines.push(line);
});
rl.on("close", () => {
  ended = true;
  for (const next of waiting.splice(0)) next(null);
});

const io: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  ask(question) {
    process.stdout.write(question);
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  },
};

runSetupCli(process.argv.slice(2), io).then(
  (code) => {
    rl.close();
    process.exit(code);
  },
  (error: unknown) => {
    console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
    rl.close();
    process.exit(1);
  },
);
