/**
 * Hash a password for the optional web login.
 *
 *   pnpm web:password            asks twice, without echo
 *   pnpm web:password --stdin    reads the password from the first line of standard input
 *
 * Prints exactly one line to standard output, `JOB_RADAR_WEB_PASSWORD_HASH=scrypt:...`, for you to paste into `.env`
 * (then rebuild the web: `docker compose up -d web`). Writes no file and never prints the password. Everything else
 * goes to standard error. The shortest password accepted is ui.yaml `web_access.min_password_length`.
 * Exit code 2 for a refused password (too short, the two entries differ, empty input).
 */
import readline from "node:readline";
import { Writable } from "node:stream";

import { getTranslator } from "../src/lib/i18n/node";
import { hashPassword, PASSWORD_HASH_ENV } from "../src/lib/security/password";
import { webAccessSettings } from "../src/lib/security/web-access-settings";

const MAX_LENGTH = 1024;

function minLength(): number {
  return webAccessSettings().min_password_length;
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return (Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "");
}

/** Ask for one line on the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<number> {
  const t = getTranslator("cli.webPassword", "cli");
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--stdin")) {
    console.error(t("usage"));
    return 2;
  }
  const min = minLength();
  let password: string;
  if (args.includes("--stdin")) {
    password = await readStdinLine();
  } else {
    if (!process.stdin.isTTY) {
      console.error(t("noTerminal"));
      return 2;
    }
    password = await askHidden(t("prompt", { min }));
    const again = await askHidden(t("repeat"));
    if (again !== password) {
      console.error(t("mismatch"));
      return 2;
    }
  }
  const length = [...password].length;
  if (length === 0) {
    console.error(t("empty"));
    return 2;
  }
  if (length < min || length > MAX_LENGTH) {
    console.error(t("length", { min, max: MAX_LENGTH }));
    return 2;
  }
  const hash = await hashPassword(password);
  process.stdout.write(`${PASSWORD_HASH_ENV}=${hash}\n`);
  console.error(t("next"));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`web:password: ${error instanceof Error ? error.name : "unexpected error"}`);
    process.exit(1);
  },
);
