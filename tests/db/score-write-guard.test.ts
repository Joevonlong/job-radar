import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function violations(text: string, fileName: string): number[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const bad: number[] = [];
  const visit = (node: ts.Node) => {
    const write = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["insert", "update", "delete"].includes(node.expression.name.text) && node.arguments.some((arg) => /^(?:schema\.)?scores$/.test(arg.getText(file)));
    const raw = ts.isTaggedTemplateExpression(node) && !/^`\s*(?:create|drop)\b/i.test(node.template.getText(file)) && /\b(?:insert\s+into|update|delete\s+from)\s+(?:"?scores"?|\$\{(?:schema\.)?scores\})(?=\s|\(|`|$)/i.test(node.template.getText(file).replace(/'(?:''|[^'])*'/g, "''"));
    if (write || raw) {
      let parent: ts.Node | undefined = node.parent;
      let allowed = false;
      while (parent) {
        if (ts.isFunctionLike(parent)) {
          allowed = parent.parameters.some((param) => param.type?.getText(file) === "ScoreTx");
          break;
        }
        parent = parent.parent;
      }
      if (!allowed) bad.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bad;
}
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? files(path.join(dir, item.name)) : /\.tsx?$/.test(item.name) ? [path.join(dir, item.name)] : []);
}
describe("score write capability", () => {
  it("rejects unbranded ORM and SQL writes, including interpolation", () => {
    for (const body of ['db.insert(scores).values({})', 'db.update(scores).set({})', 'db.delete(scores)', 'db.execute(sql`insert into scores values (1)`)', 'db.execute(sql`update ${scores} set stale = true`)', 'db.execute(sql`delete from scores`)']) {
      expect(violations(`function bad(db: Executor) { ${body}; }`, "fixture.ts")).toHaveLength(1);
      expect(violations(`function good(db: ScoreTx) { ${body}; }`, "fixture.ts")).toEqual([]);
    }
  });
  it("rejects a nested unbranded writer even inside a branded function", () => {
    expect(violations("function outer(tx: ScoreTx) { return function bad(db: Executor) { db.update(scores).set({}); }; }", "fixture.ts")).toHaveLength(1);
  });
  it("requires every product score write to have the capability", () => {
    const errors = files("src").filter((file) => !file.endsWith("/repos/current-scores.ts"))
      .flatMap((file) => violations(fs.readFileSync(file, "utf8"), file).map((line) => `${file}:${line}`));
    expect(errors).toEqual([]);
  });
});
