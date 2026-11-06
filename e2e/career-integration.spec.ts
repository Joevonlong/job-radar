import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

const wording = (id: string, text: string) => ({ id, text, lang: null, label: null, origin: "manual", from_document: null, from_story: null, created_at: "2026-01-01T00:00:00Z" });
const text = (id: string, value: string) => ({ id: `txt_${id}`, primary: `wrd_${id}`, wordings: [wording(`wrd_${id}`, value)] });

const PROFILE = {
  schema_version: 1,
  experience: [{ id: "exp_aaaaaaaaaa", company: "Example Company", url: null, location: null, start: "2020-01", end: "2022-06", role: text("aaaaaaaaab", "Engineer"), summary: text("aaaaaaaaac", "Ran the platform team."), bullets: [text("aaaaaaaaad", "Cut build time by 40%.")], stack: ["TypeScript"] }],
};

const DEFAULTS_DIR = process.env.E2E_DEFAULTS_DIR ?? path.resolve("tests/fixtures/config/defaults");

/** Career and writer on, me.yaml from the template, a career profile with one experience; all of it restored after. */
async function withCareerProfile(run: () => Promise<void>): Promise<void> {
  const dir = process.env.E2E_CONFIG_DIR;
  const profile = process.env.E2E_PROFILE_DIR;
  if (!dir || !profile) throw new Error("E2E_CONFIG_DIR and E2E_PROFILE_DIR are required");
  const files = [path.join(dir, "career.yaml"), path.join(dir, "writer.yaml"), path.join(profile, "stories.yaml"), path.join(profile, "me.yaml")];
  const originals = files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
  const career = path.join(profile, "career");
  if (fs.existsSync(career)) throw new Error("career e2e requires an unused career directory");
  fs.writeFileSync(files[0]!, "config_version: 2\nenabled: true\n");
  fs.writeFileSync(files[1]!, "enabled: true\n");
  fs.copyFileSync(path.join(DEFAULTS_DIR, "profile.example", "me.yaml"), files[3]!);
  fs.mkdirSync(career, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(career, "profile.yaml"), JSON.stringify(PROFILE), { mode: 0o600 });
  try {
    await run();
  } finally {
    files.forEach((file, index) => {
      const original = originals[index];
      if (original) fs.writeFileSync(file, original);
      else fs.rmSync(file, { force: true });
    });
    fs.rmSync(career, { recursive: true, force: true });
  }
}

test("applies the career profile to matching after a preview with the retention notice, and moves extraction to the career page", async ({ page }) => {
  await withCareerProfile(async () => {
    await page.goto("/career");
    const panel = page.getByTestId("career-apply");
    await panel.getByTestId("career-apply-preview").click();
    await expect(panel.getByTestId("career-apply-review")).toBeVisible();
    await expect(panel.getByTestId("career-apply-retention")).toContainText("数据库备份");
    const story = panel.getByTestId("career-apply-story");
    await expect(story).toHaveCount(1);
    await expect(story).toHaveAttribute("data-kind", "new");
    await expect(story).toContainText("Example Company – Engineer");
    for (const field of ["languages", "skills", "years_experience", "summary"]) {
      const row = panel.getByTestId(`career-apply-me-${field}`);
      if ((await row.count()) === 0) continue;
      const box = row.getByRole("checkbox");
      if ((await box.getAttribute("data-state")) === "checked") {
        await box.click();
        await expect(box).toHaveAttribute("data-state", "unchecked");
      }
    }
    await expect(panel.getByTestId("career-apply-stale-count")).toHaveText("不需要重新打分。");
    await panel.getByTestId("career-apply-confirm").click();
    await expect(panel.getByTestId("career-apply-result")).toHaveAttribute("data-stories", "written");
    await expect(panel.getByTestId("career-apply-result")).toHaveAttribute("data-me", "unchanged");
    expect(fs.readFileSync(path.join(process.env.E2E_PROFILE_DIR!, "stories.yaml"), "utf8")).toContain("id: career-aaaaaaaaaa");

    await page.getByRole("button", { name: "删除全部职业档案数据", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("数据库备份");
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();

    await page.goto("/me");
    const card = page.getByTestId("story-import");
    await expect(card.getByTestId("story-import-career")).toBeVisible();
    await expect(card.getByTestId("story-import-paste")).toHaveCount(0);
    await expect(card.getByTestId("story-import-upload")).toHaveCount(0);
    await expect(card.getByTestId("story-import-profile")).toHaveCount(0);
    await card.getByRole("link", { name: "去职业档案" }).click();
    await expect(page).toHaveURL(/\/career$/);
  });
});
