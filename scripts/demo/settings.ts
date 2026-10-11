/**
 * The fixed values of the README picture set (`pnpm demo:shots`): read by playwright.shots.config.ts, the specs in
 * e2e-demo/ and scripts/demo-finish.ts. No side effects on import.
 */
import path from "node:path";

/** Port of the demo web server (not the e2e default 3100, not the dashboard's 3000). */
export const DEMO_PORT = Number(process.env.DEMO_PORT ?? 3190);
/** Desktop and phone viewports; every picture is the viewport (never `fullPage`). */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
/** The job detail page is taller: the score, the salary card, the AI trap and the quoted salary sentence in one picture. */
export const DETAIL_VIEWPORT = { width: 1440, height: 1320 } as const;
/** The pipeline board is wider: all seven columns (new … offer, ended) side by side. */
export const PIPELINE_VIEWPORT = { width: 1760, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
/** The viewport the GIF is recorded at (scaled to `GIF_WIDTH` afterwards). */
export const VIDEO_VIEWPORT = { width: 1280, height: 800 } as const;
/** Where the committed pictures go, relative to the repository root. */
export const OUTPUT_DIR = "docs/images";
/** Local-only output (staging, the recorded video, the mp4 for posts): ignored by git. */
export const LOCAL_DIR = ".local-demo";
export const STAGING_DIR = path.join(LOCAL_DIR, "staging");
export const VIDEO_DIR = path.join(LOCAL_DIR, "video");
/** Budgets: all PNGs together, and the GIF. */
export const PNG_BUDGET_BYTES = 5 * 1024 * 1024;
export const GIF_BUDGET_BYTES = 5 * 1024 * 1024;
/** The GIF: width in pixels and frames per second; the retry when it is over budget. */
export const GIF_WIDTH = 960;
export const GIF_FPS = 12;
/** Palette size of the GIF (fewer colours: smaller file; the interface is mostly flat colour). */
export const GIF_COLORS = 128;
export const GIF_RETRY = { width: 800, fps: 8 } as const;
export const GIF_FILE = "job-radar-demo.gif";
