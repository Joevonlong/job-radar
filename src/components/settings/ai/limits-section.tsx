import { FieldGroups } from "./fields-block";
import { aiSectionsOf, type AiTabContext } from "./context";

/** Block 3: per-cycle work limits, cooldown and the API budget. */
export function LimitsSection({ ctx }: { ctx: AiTabContext }) {
  return <FieldGroups sections={aiSectionsOf("limits")} ctx={ctx} />;
}
