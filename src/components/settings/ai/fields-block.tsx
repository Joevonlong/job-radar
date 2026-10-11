import { FieldCell } from "../field-control";
import { sectionHint } from "../field-control";
import type { SectionDef } from "@/lib/settings/fields";

import { SubHeading } from "./block";
import type { AiTabContext } from "./context";

/** The groups of fields of a block (limits, scoring): a small heading and a grid of controls for each section. */
export function FieldGroups({ sections, ctx }: { sections: SectionDef[]; ctx: AiTabContext }) {
  return (
    <>
      {sections.map((section) => {
        const title = "section" in section.title ? ctx.t(`sections.${section.title.section}`) : section.title.text;
        const hint = "section" in section.title ? sectionHint(ctx.t, section.title.section) : undefined;
        return (
          <section key={section.id} data-testid={`section-${section.id}`} className="flex flex-col gap-3">
            <SubHeading hint={hint}>{title}</SubHeading>
            <div className="grid gap-4 sm:grid-cols-2">
              {section.fields.map((def) => (
                <FieldCell key={def.path} def={def} base={ctx.base} draft={ctx.draft} dirty={ctx.dirty} errors={ctx.errors} patch={ctx.patch} t={ctx.t} providerStates={ctx.providerStates} catalog={ctx.catalog} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
