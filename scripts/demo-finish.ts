/**
 * Second half of `pnpm demo:shots` (after the Playwright run passed): the recorded video becomes the README GIF (and a
 * local mp4 for posts), the PNGs are optionally compressed and checked against the budget, and the staged files are
 * moved to docs/images/. Needs ffmpeg; pngquant and oxipng are used when installed.
 *
 *   tsx scripts/demo-finish.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GIF_BUDGET_BYTES, GIF_COLORS, GIF_FILE, GIF_FPS, GIF_RETRY, GIF_WIDTH, LOCAL_DIR, OUTPUT_DIR, PNG_BUDGET_BYTES, STAGING_DIR, VIDEO_DIR } from "./demo/settings";

const ROOT = path.resolve(import.meta.dirname, "..");
const staging = path.join(ROOT, STAGING_DIR);
const output = path.join(ROOT, OUTPUT_DIR);
const video = path.join(ROOT, VIDEO_DIR, "demo.webm");

function fail(message: string): never {
  console.error(`demo-finish: ${message}`);
  process.exit(1);
}

function has(tool: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

if (!has("ffmpeg")) fail("ffmpeg is required (macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg)");
if (!fs.existsSync(video)) fail(`no recorded video at ${path.relative(ROOT, video)}: run the Playwright part first`);
const pngs = fs.existsSync(staging) ? fs.readdirSync(staging).filter((f) => f.endsWith(".png")).sort() : [];
if (pngs.length === 0) fail(`no pictures in ${STAGING_DIR}`);

// ---- GIF: two-pass palette, looping; one smaller retry when over budget --------------------------------------------------
function makeGif(width: number, fps: number, out: string): number {
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const palette = path.join(ROOT, LOCAL_DIR, "palette.png");
  const quiet = ["-hide_banner", "-loglevel", "error", "-y"];
  execFileSync("ffmpeg", [...quiet, "-i", video, "-vf", `${filters},palettegen=stats_mode=diff:max_colors=${GIF_COLORS}`, palette]);
  execFileSync("ffmpeg", [...quiet, "-i", video, "-i", palette, "-lavfi", `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", out]);
  fs.rmSync(palette, { force: true });
  return fs.statSync(out).size;
}
const gif = path.join(staging, GIF_FILE);
let gifBytes = makeGif(GIF_WIDTH, GIF_FPS, gif);
if (gifBytes > GIF_BUDGET_BYTES) {
  console.warn(`demo-finish: GIF is ${mib(gifBytes)} at ${GIF_WIDTH}px/${GIF_FPS}fps, over ${mib(GIF_BUDGET_BYTES)}; retrying at ${GIF_RETRY.width}px/${GIF_RETRY.fps}fps`);
  gifBytes = makeGif(GIF_RETRY.width, GIF_RETRY.fps, gif);
  if (gifBytes > GIF_BUDGET_BYTES) fail(`GIF is still ${mib(gifBytes)}, over the ${mib(GIF_BUDGET_BYTES)} budget: shorten e2e-demo/gif.spec.ts`);
}

// the mp4 stays local (for posts), never committed
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(ROOT, LOCAL_DIR, "job-radar-demo.mp4")]);

// ---- PNGs: optional lossless/lossy compression, then the budget ------------------------------------------------------------
const tools = { pngquant: has("pngquant"), oxipng: has("oxipng") };
for (const file of pngs) {
  const full = path.join(staging, file);
  if (tools.pngquant) execFileSync("pngquant", ["--force", "--skip-if-larger", "--quality", "70-95", "--strip", "--output", full, full], { stdio: "ignore" });
  if (tools.oxipng) execFileSync("oxipng", ["-o", "3", "--strip", "safe", full], { stdio: "ignore" });
}
const sizes = pngs.map((file) => ({ file, bytes: fs.statSync(path.join(staging, file)).size })).sort((a, b) => b.bytes - a.bytes);
const total = sizes.reduce((sum, s) => sum + s.bytes, 0);
if (total > PNG_BUDGET_BYTES) {
  const largest = sizes
    .slice(0, 3)
    .map((s) => `${s.file} ${mib(s.bytes)}`)
    .join(", ");
  const message = `PNGs total ${mib(total)}, over the ${mib(PNG_BUDGET_BYTES)} budget (largest: ${largest})`;
  if (tools.pngquant || tools.oxipng) fail(message);
  console.warn(`demo-finish: warning: ${message}; install pngquant or oxipng to compress them`);
}

// ---- move into docs/images/ -----------------------------------------------------------------------------------------------
fs.mkdirSync(output, { recursive: true });
for (const file of [...pngs, GIF_FILE]) fs.renameSync(path.join(staging, file), path.join(output, file));
for (const s of sizes) console.log(`  ${OUTPUT_DIR}/${s.file}  ${(s.bytes / 1024).toFixed(0)} KiB`);
console.log(`  ${OUTPUT_DIR}/${GIF_FILE}  ${(gifBytes / 1024).toFixed(0)} KiB`);
console.log(`demo-finish: ${pngs.length} PNGs (${mib(total)}) and the GIF written to ${OUTPUT_DIR}/; mp4 in ${LOCAL_DIR}/`);
