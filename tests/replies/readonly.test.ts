import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", file), "utf8");

/** The promises the guide makes, held against the source: the reply reader cannot write to the mailbox and sends no mail anywhere. */
describe("reply reading stays local and read-only", () => {
  it("there is no way to send mail", () => {
    expect(read("package.json")).not.toMatch(/nodemailer|smtp/i);
  });

  const sources = ["types", "sanitize", "classify", "match", "suggest", "filter-query", "step"].map((name) => read(`src/lib/replies/${name}.ts`)).join("\n");

  it("no replies module reaches AI, Telegram or the network", () => {
    expect(sources).not.toMatch(/from "@\/lib\/(ai|notify|llm)/);
    expect(sources).not.toMatch(/\bfetch\(/);
  });

  it("the mail session has no method that changes the mailbox", () => {
    const imap = read("src/lib/channels/email/imap.ts");
    expect(imap).toMatch(/readOnly: true/);
    expect(imap).not.toMatch(/\.(messageFlagsAdd|messageFlagsRemove|messageFlagsSet|messageDelete|messageMove|messageCopy|append|mailboxCreate|mailboxDelete|mailboxRename)\(/);
  });
});
