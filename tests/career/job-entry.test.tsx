import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
import { JobEntry } from "@/components/career/job-entry";
import { createDocument, listJobDocuments } from "@/lib/career/store/documents";
import { careerDocumentsDir } from "@/lib/career/store/paths";
import { descriptionHash } from "@/lib/translation/hash";
import { tempCareer } from "./fixtures";
import { tailorFixture } from "./tailor-fixtures";

let temp: ReturnType<typeof tempCareer> | undefined;
afterEach(() => {
  if (temp && fs.existsSync(careerDocumentsDir())) fs.chmodSync(careerDocumentsDir(), 0o700);
  temp?.cleanup();
  temp = undefined;
});

async function tailored(jobId: number | null, description: string, title: string) {
  const { doc } = tailorFixture();
  const job = jobId === null ? null : { id: jobId, company: "Example", title: "Engineer", jd_hash: descriptionHash(description) };
  return (await createDocument({ ...doc, id: "", title, job })).document;
}

it("lists only this job's documents and marks a changed description", async () => {
  temp = tempCareer();
  const same = await tailored(7, "Current description", "Same JD");
  const changed = await tailored(7, "Old description", "Changed JD");
  await tailored(8, "Current description", "Other job");
  await tailored(null, "", "General");
  const found = await listJobDocuments(7, descriptionHash("Current description"));
  expect(found.map((item) => [item.id, item.jdChanged]).sort()).toEqual([[changed.id, true], [same.id, false]].sort());
  const html = renderToStaticMarkup(await JobEntry({ jobId: 7, description: "Current description" }));
  expect(html).toContain('href="/career/tailor?job=7"');
  expect(html).toContain(`href="/career/documents/${same.id}"`);
  expect(html.match(/career-job-jd-changed/g)).toHaveLength(1);
  expect(html).not.toContain("Other job");
});

it("lists a job's documents even when the document limit was lowered below the number of files", async () => {
  temp = tempCareer();
  await tailored(9, "Other", "First");
  await tailored(9, "Other", "Second");
  const mine = await tailored(7, "Description", "Mine");
  const file = path.join(temp.configDir, "career.yaml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/max_documents: \d+/, "max_documents: 1"));
  expect((await listJobDocuments(7, null)).map((item) => item.id)).toEqual([mine.id]);
});

it("shows an error state without file content when a document is invalid or the folder is unreadable", async () => {
  temp = tempCareer();
  await tailored(7, "Description", "Readable");
  fs.writeFileSync(path.join(careerDocumentsDir(), "doc_aaaaaaaaaa.yaml"), "secret: Private Sentinel Text\n");
  let html = renderToStaticMarkup(await JobEntry({ jobId: 7, description: "Description" }));
  expect(html).toContain("career-job-error");
  expect(html).not.toContain("Private Sentinel");
  expect(html).toContain('href="/career/tailor?job=7"');
  fs.rmSync(path.join(careerDocumentsDir(), "doc_aaaaaaaaaa.yaml"));
  fs.chmodSync(careerDocumentsDir(), 0o000);
  html = renderToStaticMarkup(await JobEntry({ jobId: 7, description: "Description" }));
  expect(html).toContain("career-job-error");
});

it("an empty career folder shows the tailor link and no documents", async () => {
  temp = tempCareer();
  const html = renderToStaticMarkup(await JobEntry({ jobId: 3, description: null }));
  expect(html).toContain('href="/career/tailor?job=3"');
  expect(html).not.toContain("career-job-documents");
  expect(html).not.toContain("career-job-error");
});
