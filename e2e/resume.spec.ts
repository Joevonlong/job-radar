import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The resume-kit hand-off on the seeded e2e database: job detail -> "定制简历" -> path and command ->
 * attach a PDF -> the resume shows on the job. Fictional seed job: "Data Engineer" (Orbitrail AG), which
 * no other spec touches. The spec writes its own resume.yaml into the run's config directory (the page
 * re-reads it on every request) and works in temporary directories.
 */

const PORT = process.env.E2E_PORT ?? "3100";
const root = path.join(os.tmpdir(), `job-radar-e2e-resume-${PORT}`);
const kitDir = path.join(root, "resume-kit");
const pdfDir = path.join(root, "pdfs");
const jdDir = path.join(root, "jd");
const outsideDir = path.join(root, "secret");

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const dir of [kitDir, pdfDir, jdDir, outsideDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(pdfDir, "Orbitrail_Data-Engineer.pdf"), "%PDF-1.4\n");
  fs.writeFileSync(path.join(outsideDir, "Secret.pdf"), "%PDF-1.4\n");
  const configDir = process.env.E2E_CONFIG_DIR;
  if (!configDir) throw new Error("E2E_CONFIG_DIR is not set");
  fs.writeFileSync(
    path.join(configDir, "resume.yaml"),
    [
      `resume_kit_path: ${JSON.stringify(kitDir)}`,
      "master_resume_path: null",
      `pdf_dir: ${JSON.stringify(pdfDir)}`,
      `jd_export_dir: ${JSON.stringify(jdDir)}`,
      "jd_export_host_dir: null",
      "claude_command: claude",
      "filename_part_max_chars: 48",
      "signal_quote_max_chars: 240",
      "pdf_list_limit: 50",
      "",
    ].join("\n"),
  );
});

test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function openJob(page: Page) {
  await page.goto("/jobs");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /Data Engineer/ }).first().click();
  await page.waitForURL(/\/jobs\/\d+$/);
  await page.waitForLoadState("networkidle");
}

test("detail -> tailor resume -> path and command -> attach PDF -> the resume shows", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openJob(page);
  const panel = page.getByTestId("resume-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("resume-current")).toHaveCount(0);

  // 1. export: the JD path, the command, the status
  await page.getByTestId("resume-export").click();
  const jdPath = page.getByTestId("resume-jd-path");
  await expect(jdPath).toBeVisible();
  const exportedPath = (await jdPath.textContent()) ?? "";
  expect(path.dirname(exportedPath)).toBe(jdDir);
  expect(path.basename(exportedPath)).toMatch(/^orbitrail-ag-data-engineer-\d{4}-\d{2}-\d{2}\.md$/);
  const command = page.getByTestId("resume-command");
  const expectedCommand = `cd ${kitDir} && claude --disallowed-tools=WebFetch,WebSearch "/tailor ${exportedPath} exports-folder=${pdfDir}"`;
  await expect(command).toHaveText(expectedCommand);
  await expect(page.getByTestId("resume-status-note")).toContainText("准备中");
  await expect(page.getByTestId("status-select")).toHaveValue("preparing");

  // the file is there: front matter + the original JD
  const text = fs.readFileSync(exportedPath, "utf8");
  expect(text).toMatch(/^---\njob_id: \d+\ncompany: Orbitrail AG\n/);
  expect(text).toContain("title: Data Engineer");
  expect(text).toContain("Betriebliche Altersvorsorge.");

  // 2. copy the command
  await page.getByTestId("resume-copy").click();
  await expect(page.getByTestId("resume-copy")).toContainText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCommand);

  // 3. a second export rewrites the same file
  await page.getByTestId("resume-export").click();
  await expect(page.getByTestId("resume-status-note")).toContainText("已经是");
  expect(fs.readdirSync(jdDir)).toEqual([path.basename(exportedPath)]);

  // 4. attaching outside pdf_dir is refused, a PDF of the directory is attached
  const input = page.getByTestId("resume-pdf-input");
  await input.fill("../secret/Secret.pdf");
  await page.getByTestId("resume-attach").click();
  await expect(page.getByTestId("resume-attach-error")).toContainText("pdf_dir");
  await input.fill(path.join(outsideDir, "Secret.pdf"));
  await page.getByTestId("resume-attach").click();
  await expect(page.getByTestId("resume-attach-error")).toContainText("pdf_dir");
  await expect(page.getByTestId("resume-current")).toHaveCount(0);

  await input.fill("Orbitrail_Data-Engineer.pdf");
  await page.getByTestId("resume-attach").click();
  await expect(page.getByTestId("resume-current")).toContainText("简历：Orbitrail_Data-Engineer.pdf");
  // also next to the status chip in the header
  await expect(page.getByTestId("job-detail").locator("[data-slot='resume-chip']").first()).toContainText("简历：Orbitrail_Data-Engineer.pdf");

  // 5. it survives a reload, and can be detached
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("resume-current")).toContainText("Orbitrail_Data-Engineer.pdf");
  await page.getByTestId("resume-detach").click();
  await expect(page.getByTestId("resume-current")).toHaveCount(0);
  expect(fs.existsSync(path.join(pdfDir, "Orbitrail_Data-Engineer.pdf"))).toBe(true);
});

test("without resume_kit_path the panel shows the file but explains the missing command", async ({ page }) => {
  const configFile = path.join(process.env.E2E_CONFIG_DIR ?? "", "resume.yaml");
  const original = fs.readFileSync(configFile, "utf8");
  fs.writeFileSync(configFile, original.replace(/^resume_kit_path: .*$/m, "resume_kit_path: null"));
  try {
    await openJob(page);
    await page.getByTestId("resume-export").click();
    await expect(page.getByTestId("resume-jd-path")).toBeVisible();
    await expect(page.getByTestId("resume-no-kit")).toContainText("resume_kit_path");
    await expect(page.getByTestId("resume-command")).toHaveCount(0);
  } finally {
    fs.writeFileSync(configFile, original);
  }
});

test.describe("mobile (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the panel does not scroll horizontally", async ({ page }) => {
    await openJob(page);
    await page.getByTestId("resume-export").click();
    await expect(page.getByTestId("resume-command")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
