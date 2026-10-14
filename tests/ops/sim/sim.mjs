// A stateful stand-in for `launchctl` and `systemctl --user`, for the tests of the ai-worker scripts
// (scripts/ops/install-ai-worker.sh, uninstall-ai-worker.sh). Nothing real is touched: the state is one JSON file in
// $JOB_RADAR_SIM_DIR, every call is appended to $JOB_RADAR_SIM_DIR/calls.log (one JSON line: t = epoch ms, tool, argv),
// and a "loaded" service is a real process started from the definition's command (detached, in its own session),
// with the full environment of the caller plus the definition's variables.
//
// launchd: ~/Library/LaunchAgents plists are read with the small XML parser below. Covered: print (pid = …),
// print-disabled (the override table), enable, disable, bootstrap (fails for a disabled label, or an injected one),
// bootout (SIGTERM, SIGKILL after ExitTimeOut unless injected noKill).
// systemd: the unit directory is $XDG_CONFIG_HOME/systemd/user. Covered: daemon-reload (snapshots the unit file),
// enable / disable (real symbolic links in <WantedBy>.wants/, from the unit's [Install]), is-enabled (from the links;
// masked can be injected), is-active, start, stop (the unit stays loaded; an auto-restart can be injected), show (-p,
// --value), list-jobs, show-environment.
//
// Injections (state.inject, set by the tests): bootstrapFail: string[] (labels), startFail: boolean, failStarts: number
// (the next N bootstrap / start calls fail, then they work again), noKill: boolean,
// masked: boolean, stuckAfterStop: boolean (systemd: activating / auto-restart after a stop), pendingJob: boolean.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIM_DIR = process.env.JOB_RADAR_SIM_DIR ?? "";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function statePath() {
  if (!SIM_DIR) fail("sim: JOB_RADAR_SIM_DIR is not set", 99);
  return path.join(SIM_DIR, "state.json");
}

export function loadState() {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    state = {};
  }
  state.launchd ??= { loaded: {}, disabled: {} };
  state.systemd ??= { units: {} };
  state.inject ??= {};
  state.spawned ??= [];
  return state;
}

export function saveState(state) {
  const file = statePath();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function record(tool, argv) {
  fs.appendFileSync(path.join(SIM_DIR, "calls.log"), `${JSON.stringify({ t: Date.now(), tool, argv })}\n`);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, then (unless noKill) SIGKILL after `timeoutSeconds`; waits until the process is gone or given up on. */
async function terminate(pid, timeoutSeconds, noKill) {
  if (!alive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (alive(pid) && !noKill) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  }
}

/** Starts a definition's command detached; its output goes to `logFile`. Returns the PID. */
function startProcess(state, argv, cwd, env, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, "a");
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.closeSync(out);
  state.spawned.push(child.pid);
  return child.pid;
}

// ---- plist (the XML form the install script writes) ------------------------------------------------------------
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unescapeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);

export function parsePlist(text) {
  const tokens = [...text.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([a-z]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g)];
  let i = 0;
  const next = () => tokens[i++];
  const skipWs = () => {
    while (i < tokens.length && tokens[i][4] !== undefined && tokens[i][4].trim() === "") i++;
  };
  const textUntil = (tag) => {
    let s = "";
    for (;;) {
      const t = next();
      if (!t) throw new Error(`plist: unterminated <${tag}>`);
      if (t[4] !== undefined) s += t[4];
      else if (t[1] === "/" && t[2] === tag) return unescapeXml(s);
      else throw new Error(`plist: unexpected <${t[2]}> in <${tag}>`);
    }
  };
  const value = () => {
    skipWs();
    const t = next();
    if (!t || t[4] !== undefined) throw new Error("plist: expected an element");
    const [, close, tag, empty] = t;
    if (close) throw new Error(`plist: unexpected </${tag}>`);
    if (tag === "true" && empty) return true;
    if (tag === "false" && empty) return false;
    if (tag === "string" && empty) return "";
    if (tag === "string") return textUntil("string");
    if (tag === "integer") return Number(textUntil("integer"));
    if (tag === "array") {
      const out = [];
      for (;;) {
        skipWs();
        if (tokens[i]?.[1] === "/" && tokens[i]?.[2] === "array") return (i++, out);
        out.push(value());
      }
    }
    if (tag === "dict") {
      const out = {};
      for (;;) {
        skipWs();
        if (tokens[i]?.[1] === "/" && tokens[i]?.[2] === "dict") return (i++, out);
        const k = next();
        if (!k || k[2] !== "key") throw new Error("plist: expected <key>");
        out[textUntil("key")] = value();
      }
    }
    throw new Error(`plist: unsupported <${tag}>`);
  };
  skipWs();
  const root = next();
  if (!root || root[2] !== "plist") throw new Error("plist: no <plist>");
  const v = value();
  skipWs();
  if (next()?.[2] !== "plist") throw new Error("plist: no </plist>");
  return v;
}

/** failStarts: true (and one less) while the counter is above 0; the state is saved by the caller's fail path here. */
function consumeFailStart(state) {
  if (!(state.inject.failStarts > 0)) return false;
  state.inject.failStarts -= 1;
  saveState(state);
  return true;
}

// ---- launchctl -------------------------------------------------------------------------------------------------
function labelOf(target) {
  const m = /^gui\/\d+\/(.+)$/.exec(target ?? "");
  if (!m) fail(`launchctl: bad service target ${target}`, 64);
  return m[1];
}

export async function launchctl(argv) {
  record("launchctl", argv);
  const state = loadState();
  const ld = state.launchd;
  const [cmd, target, file] = argv;
  switch (cmd) {
    case "print": {
      const label = labelOf(target);
      const job = ld.loaded[label];
      if (!job) fail(`Could not find service "${label}" in domain for port`, 113);
      const running = alive(job.pid);
      process.stdout.write(`${target} = {\n\tactive count = ${running ? 1 : 0}\n\tpath = ${job.plist}\n\tstate = ${running ? "running" : "not running"}\n\n\tprogram = ${job.argv[0]}\n${running ? `\tpid = ${job.pid}\n` : ""}}\n`);
      return 0;
    }
    case "print-disabled": {
      const lines = Object.entries(ld.disabled).map(([label, d]) => `\t"${label}" => ${d ? "disabled" : "enabled"}`);
      process.stdout.write(`disabled services = {\n${lines.join("\n")}${lines.length ? "\n" : ""}}\n`);
      return 0;
    }
    case "enable":
    case "disable": {
      ld.disabled[labelOf(target)] = cmd === "disable";
      saveState(state);
      return 0;
    }
    case "bootstrap": {
      let plist;
      try {
        plist = parsePlist(fs.readFileSync(file, "utf8"));
      } catch (error) {
        fail(`Bootstrap failed: 5: Input/output error (${error.message})`, 5);
      }
      const label = plist.Label;
      if (ld.disabled[label] === true) fail(`Bootstrap failed: 5: Input/output error (service ${label} is disabled)`, 5);
      if (ld.loaded[label]) fail("Bootstrap failed: 5: Input/output error (service already loaded)", 5);
      if ((state.inject.bootstrapFail ?? []).includes(label)) fail("Bootstrap failed: 5: Input/output error (injected)", 5);
      if (consumeFailStart(state)) fail("Bootstrap failed: 5: Input/output error (injected once)", 5);
      const argvJob = plist.ProgramArguments;
      const pid = startProcess(state, argvJob, plist.WorkingDirectory, plist.EnvironmentVariables ?? {}, plist.StandardOutPath ?? path.join(SIM_DIR, `${label}.log`));
      ld.loaded[label] = { plist: file, pid, argv: argvJob, cwd: plist.WorkingDirectory, exitTimeout: plist.ExitTimeOut ?? 20 };
      saveState(state);
      return 0;
    }
    case "bootout": {
      const label = labelOf(target);
      const job = ld.loaded[label];
      if (!job) fail("Boot-out failed: 3: No such process", 3);
      delete ld.loaded[label];
      saveState(state);
      await terminate(job.pid, job.exitTimeout, state.inject.noKill === true);
      return 0;
    }
    default:
      fail(`launchctl (sim): unsupported command ${cmd}`, 64);
  }
  return 0;
}

// ---- systemctl --user ------------------------------------------------------------------------------------------
const unitDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd/user");

/** The words of an ExecStart= line as systemd splits them (quotes group; \\ \" %% $$ unescaped). */
export function execWords(line) {
  const words = [];
  let cur = "";
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (c === "\\" && (n === "\\" || n === '"')) {
      cur += n;
      i++;
      inWord = true;
    } else if ((c === "%" || c === "$") && n === c) {
      cur += c;
      i++;
      inWord = true;
    } else if (c === '"') {
      quoted = !quoted;
      inWord = true;
    } else if (!quoted && /\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

export function parseUnit(text) {
  const unit = { env: {}, wantedBy: [], exec: [], cwd: "", timeoutStop: 90 };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = /^WorkingDirectory=(.*)$/.exec(line))) unit.cwd = m[1].replaceAll("%%", "%");
    else if ((m = /^ExecStart=(.*)$/.exec(line))) unit.exec = execWords(m[1]);
    else if ((m = /^Environment="(.*)"$/.exec(line))) {
      const v = m[1].replace(/\\(["\\])|%%/g, (s, q) => q ?? "%");
      const eq = v.indexOf("=");
      unit.env[v.slice(0, eq)] = v.slice(eq + 1);
    } else if ((m = /^WantedBy=(.*)$/.exec(line))) unit.wantedBy.push(...m[1].split(/\s+/).filter(Boolean));
    else if ((m = /^TimeoutStopSec=(\d+)$/.exec(line))) unit.timeoutStop = Number(m[1]);
  }
  return unit;
}

function wantsLinks(name) {
  const dir = unitDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => d.endsWith(".wants"))
    .map((d) => path.join(dir, d, name))
    .filter((p) => {
      try {
        fs.lstatSync(p);
        return true;
      } catch {
        return false;
      }
    });
}

function unitState(state, name) {
  state.systemd.units[name] ??= { active: "inactive", sub: "dead", pid: 0, nrestarts: 0, loaded: null };
  const u = state.systemd.units[name];
  if (u.active === "active" && !alive(u.pid)) Object.assign(u, { active: "failed", sub: "failed", pid: 0 });
  return u;
}

export async function systemctl(argvIn) {
  record("systemctl", argvIn);
  const argv = argvIn.filter((a) => a !== "--user" && a !== "--quiet" && a !== "--no-legend" && a !== "--no-pager");
  const state = loadState();
  const sd = state.systemd;
  const now = argv.includes("--now");
  const args = argv.filter((a) => a !== "--now");
  const cmd = args[0];
  const name = args.at(-1);
  const file = path.join(unitDir(), name ?? "");
  switch (cmd) {
    case "show-environment":
      process.stdout.write("PATH=/usr/bin\n");
      return 0;
    case "daemon-reload":
      for (const [n, u] of Object.entries(sd.units)) {
        const f = path.join(unitDir(), n);
        u.loaded = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
      }
      for (const f of fs.existsSync(unitDir()) ? fs.readdirSync(unitDir()) : []) {
        if (f.endsWith(".service") && !sd.units[f]) unitState(state, f).loaded = fs.readFileSync(path.join(unitDir(), f), "utf8");
      }
      saveState(state);
      return 0;
    case "is-enabled": {
      if (state.inject.masked) {
        process.stdout.write("masked\n");
        return 1;
      }
      if (!fs.existsSync(file)) fail(`Failed to get unit file state for ${name}: No such file or directory`, 1);
      const enabled = wantsLinks(name).length > 0;
      process.stdout.write(`${enabled ? "enabled" : "disabled"}\n`);
      return enabled ? 0 : 1;
    }
    case "is-active": {
      const u = unitState(state, name);
      saveState(state);
      process.stdout.write(`${u.active}\n`);
      return u.active === "active" ? 0 : 3;
    }
    case "enable": {
      if (!fs.existsSync(file)) fail(`Failed to enable unit: Unit file ${name} does not exist.`, 1);
      for (const target of parseUnit(fs.readFileSync(file, "utf8")).wantedBy) {
        const dir = path.join(unitDir(), `${target}.wants`);
        fs.mkdirSync(dir, { recursive: true });
        const link = path.join(dir, name);
        try {
          fs.lstatSync(link);
        } catch {
          fs.symlinkSync(file, link);
        }
      }
      if (now) return systemctl(["start", name]);
      return 0;
    }
    case "disable": {
      for (const link of wantsLinks(name)) fs.unlinkSync(link);
      if (now) return systemctl(["stop", name]);
      return 0;
    }
    case "start": {
      const u = unitState(state, name);
      if (!u.loaded) fail(`Failed to start ${name}: Unit ${name} not found.`, 5);
      if (u.active === "active") return 0;
      if (state.inject.startFail || consumeFailStart(state)) {
        Object.assign(u, { active: "failed", sub: "failed", pid: 0 });
        saveState(state);
        fail(`Job for ${name} failed (injected).`, 1);
      }
      const unit = parseUnit(u.loaded);
      const pid = startProcess(state, unit.exec, unit.cwd, unit.env, path.join(SIM_DIR, `${name}.journal`));
      Object.assign(u, { active: "active", sub: "running", pid, timeoutStop: unit.timeoutStop });
      saveState(state);
      return 0;
    }
    case "stop": {
      const u = unitState(state, name);
      const pid = u.pid;
      Object.assign(u, { active: "deactivating", sub: "stop-sigterm" });
      saveState(state);
      await terminate(pid, u.timeoutStop ?? 90, state.inject.noKill === true);
      const after = loadState();
      const v = unitState(after, name);
      if (after.inject.stuckAfterStop) Object.assign(v, { active: "activating", sub: "auto-restart", pid: 0, nrestarts: v.nrestarts + 1 });
      else Object.assign(v, { active: "inactive", sub: "dead", pid: alive(pid) ? pid : 0 });
      saveState(after);
      return 0;
    }
    case "show": {
      const u = unitState(state, name);
      if (u.active === "activating" && u.sub === "auto-restart") u.nrestarts += 1; // a restart keeps being queued
      saveState(state);
      const props = {
        ActiveState: u.active,
        SubState: u.sub,
        MainPID: String(u.pid && alive(u.pid) ? u.pid : 0),
        NRestarts: String(u.nrestarts),
        LoadState: u.loaded || fs.existsSync(file) ? "loaded" : "not-found",
      };
      const p = args.indexOf("-p");
      const wanted = p >= 0 ? args[p + 1].split(",") : Object.keys(props);
      const valueOnly = args.includes("--value");
      process.stdout.write(wanted.map((k) => (valueOnly ? `${props[k] ?? ""}` : `${k}=${props[k] ?? ""}`)).join("\n") + "\n");
      return 0;
    }
    case "list-jobs":
      if (state.inject.pendingJob) process.stdout.write(`1 ${name} start waiting\n`);
      return 0;
    case "cat":
      if (!fs.existsSync(file)) fail(`No files found for ${name}.`, 1);
      process.stdout.write(fs.readFileSync(file, "utf8"));
      return 0;
    default:
      fail(`systemctl (sim): unsupported command ${cmd}`, 64);
  }
  return 0;
}

// ---- plutil (Linux has none; macOS uses the real one) ----------------------------------------------------------
export function plutil(argv) {
  const [flag] = argv;
  const file = argv.at(-1);
  const plist = (() => {
    try {
      return parsePlist(fs.readFileSync(file, "utf8"));
    } catch (error) {
      fail(`${file}: ${error.message}`, 1);
    }
    return null;
  })();
  if (flag === "-lint") {
    process.stdout.write(`${file}: OK\n`);
    return 0;
  }
  if (flag === "-convert") {
    process.stdout.write(fs.readFileSync(file, "utf8"));
    return 0;
  }
  if (flag === "-extract" && argv[2] === "raw") {
    let v = plist;
    for (const key of argv[1].split(".")) v = v && typeof v === "object" ? v[key] : undefined;
    if (v === undefined || typeof v === "object") fail(`Could not extract value, error: No value at that key path`, 1);
    process.stdout.write(`${v === true ? "true" : v === false ? "false" : v}\n`);
    return 0;
  }
  fail(`plutil (sim): unsupported ${argv.join(" ")}`, 64);
  return 0;
}
