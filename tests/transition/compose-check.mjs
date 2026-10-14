// Safety check of the upgrade transition (tests/transition/run.sh): may this compose project be started, or removed?
//
//   node compose-check.mjs config  <project> <prefix> <root> <ports file>   < `docker compose config --format json`
//   node compose-check.mjs inspect <project> <prefix> <root>                < `docker inspect` of the project's containers
//
// config: the project is named <prefix>…; every named volume is <prefix>… and not external; every bind mount and build
// context lies under <root>; no container_name; every published port is one of the ports file (the ports this run
// picked for the project, one per line). inspect: every volume a container mounts is <prefix>… (or anonymous), every
// bind mount lies under <root>. Exit 0 = safe; 1 = not safe (each reason on stderr); 2 = bad input.
import fs from "node:fs";
import path from "node:path";

const [mode, project, prefix, root, portsFile] = process.argv.slice(2);
if (!["config", "inspect"].includes(mode) || !project || !prefix || !root || (mode === "config" && !portsFile)) {
  console.error("usage: compose-check.mjs config|inspect <project> <prefix> <root> [<ports file>]");
  process.exit(2);
}
if (!prefix.startsWith("jrtransition-") || !path.isAbsolute(root)) {
  console.error(`compose-check: prefix must start with jrtransition- and root must be absolute (${prefix}, ${root})`);
  process.exit(2);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
  console.error(`compose-check: the input is not JSON: ${e.message}`);
  process.exit(2);
}

// The same directory can be named with or without macOS's /private, and Docker Desktop may show it under /host_mnt.
const roots = new Set([root, root.replace(/^\/private\//, "/"), `/private${root}`]);
const under = (p) => {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  const clean = path.normalize(p).replace(/^\/host_mnt\//, "/");
  return [...roots].some((r) => clean === r || clean.startsWith(`${r}/`));
};
const anonymous = (name) => /^[0-9a-f]{64}$/.test(name ?? "");

const problems = [];
if (!project.startsWith(prefix)) problems.push(`project ${project} is not named ${prefix}…`);

if (mode === "config") {
  if (data.name !== project) problems.push(`the configuration is of project ${data.name}, not ${project}`);
  let allowed = [];
  try {
    allowed = fs.readFileSync(portsFile, "utf8").split(/\s+/).filter(Boolean);
  } catch {
    problems.push(`no ports were registered for ${project} (${portsFile})`);
  }
  for (const [key, vol] of Object.entries(data.volumes ?? {})) {
    if (vol?.external) problems.push(`volume ${key} is external`);
    if (typeof vol?.name !== "string" || !vol.name.startsWith(prefix)) problems.push(`volume ${key} is named ${vol?.name}, not ${prefix}…`);
  }
  for (const [name, svc] of Object.entries(data.services ?? {})) {
    if (svc.container_name !== undefined) problems.push(`service ${name} sets container_name ${svc.container_name}`);
    for (const m of svc.volumes ?? []) {
      if (m.type === "volume") {
        if (m.source !== undefined && !(m.source in (data.volumes ?? {}))) problems.push(`service ${name} mounts volume ${m.source}, which the project does not define`);
      } else if (m.type === "bind") {
        if (!under(m.source)) problems.push(`service ${name} mounts ${m.source}, outside ${root}`);
      } else if (m.type !== "tmpfs") {
        problems.push(`service ${name} has a mount of type ${m.type}`);
      }
    }
    if (svc.build !== undefined) {
      const context = typeof svc.build === "string" ? svc.build : svc.build.context;
      if (!under(context)) problems.push(`service ${name} builds from ${context}, outside ${root}`);
    }
    for (const p of svc.ports ?? []) {
      const published = String(p.published ?? "");
      if (!allowed.includes(published)) problems.push(`service ${name} publishes port ${published || "(any)"}, not one of ${allowed.join(", ") || "(none)"}`);
    }
  }
} else {
  if (!Array.isArray(data)) {
    console.error("compose-check: docker inspect gives an array");
    process.exit(2);
  }
  for (const c of data) {
    const name = c.Name ?? c.Id;
    if (c.Config?.Labels?.["com.docker.compose.project"] !== project) problems.push(`container ${name} is not of project ${project}`);
    for (const m of c.Mounts ?? []) {
      if (m.Type === "volume") {
        if (!anonymous(m.Name) && !String(m.Name).startsWith(prefix)) problems.push(`container ${name} mounts volume ${m.Name}, not ${prefix}…`);
      } else if (m.Type === "bind") {
        if (!under(m.Source)) problems.push(`container ${name} mounts ${m.Source}, outside ${root}`);
      } else if (m.Type !== "tmpfs") {
        problems.push(`container ${name} has a mount of type ${m.Type}`);
      }
    }
  }
}

for (const p of problems) console.error(`compose-check: ${p}`);
process.exit(problems.length === 0 ? 0 : 1);
