/**
 * pnpm run setup [--step <id>] [--answers <file.yaml>] [--status [--json]] [--complete] [--no-restart] [--lang en|zh]
 * (`pnpm setup` alone is pnpm's own command.)
 *
 * The first-run setup on the command line (docs/setup.md): the same eight steps as the web wizard at /setup,
 * writing the same files. Interactive by default; `--answers` runs unattended, `--step` runs one step, `--status` only
 * prints where the setup stands, `--complete` marks it done without changing any configuration. The Telegram step
 * (`--step telegram`, docs/telegram.md) asks for the bot token without echoing it, writes it to .env and restarts web,
 * runner and the ai-worker (`--no-restart`: print the commands instead).
 * Exit codes: 0 done, 1 a step or the completion failed, 2 bad arguments or an unreadable answers file.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { runSetupCli, type CliIo } from "../src/lib/setup/cli";
import { heldInterruptNote } from "../src/lib/setup/interrupt-guard";

const lines: string[] = [];
const waiting: Array<(line: string | null) => void> = [];
let ended = false;
/** While true, what is typed is not echoed (the bot token). */
let muted = false;

const output = new Writable({
  write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  },
});
// readline sizes its line editing from these
Object.assign(output, { isTTY: process.stdout.isTTY === true, columns: process.stdout.columns });

const terminal = process.stdin.isTTY === true;
// no history: a secret typed into the prompt must not stay in memory longer than needed
const rl = createInterface({ input: process.stdin, output, terminal, historySize: 0 });
rl.on("line", (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else lines.push(line);
});
rl.on("close", () => {
  ended = true;
  for (const next of waiting.splice(0)) next(null);
});

// Ctrl-C / SIGTERM: stop waiting and let the command clean up (it starts a runner it stopped). A further one exits at
// once, except while services are being restarted or a stopped runner is not back yet: then it says so and goes on.
// The service commands run in a process group of their own, so the terminal's Ctrl-C never reaches them.
const controller = new AbortController();
const interrupt = (): void => {
  if (controller.signal.aborted) {
    const note = heldInterruptNote();
    if (note === null) process.exit(130);
    process.stdout.write(`\n${note}\n`);
    return;
  }
  muted = false;
  process.stdout.write("\n");
  controller.abort();
  rl.close();
};
rl.on("SIGINT", interrupt);
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

function ask(question: string): Promise<string | null> {
  process.stdout.write(question);
  const line = lines.shift();
  if (line !== undefined) return Promise.resolve(line);
  if (ended) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
}

const io: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  ask,
  async askSecret(question) {
    if (!terminal) return ask(question);
    muted = true;
    try {
      return await ask(question);
    } finally {
      muted = false;
      process.stdout.write("\n");
    }
  },
  signal: controller.signal,
};

runSetupCli(process.argv.slice(2), io).then(
  (code) => {
    rl.close();
    process.exit(controller.signal.aborted && code === 0 ? 130 : code);
  },
  (error: unknown) => {
    console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
    rl.close();
    process.exit(1);
  },
);
