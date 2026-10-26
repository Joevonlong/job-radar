/**
 * Setup step 5: where to collect. Switches channels on / off and adds company career boards through the source registry
 * services (`setSourceEnabled`, `saveAtsBoard`: one validated write each, comments kept, mirrored into the database).
 * The boards are checked before the first write, so a bad board never leaves the switches half applied.
 */
import { consentKind } from "@/lib/channels/access";
import { CHANNEL_CONFIG_TABLE, isConfiguredChannelId, isOtherMarket, type ConfiguredChannelId } from "@/lib/channels/registry";
import { ATS_KINDS, atsBoardEntrySchema, type ChannelsConfig } from "@/lib/config";
import { saveAtsBoard, setSourceEnabled, type RegistryActionState } from "@/lib/sources/registry/service";

import { sourcesInputSchema } from "../inputs";
import { readSetupState } from "../state";
import { stepError, type SetupFieldError, type SetupFormError, type SetupStepResult } from "../types";
import { finishStep, readFresh, setupFrozen } from "./common";

/** The "recommended for you" read is a sub-switch of the LinkedIn session, not a source of its own. */
const SUB_SWITCHES: readonly ConfiguredChannelId[] = ["linkedin-session:recommended"];

/** The channels the step offers: every configured channel the current market can use. */
export function offeredChannelIds(config: ChannelsConfig): ConfiguredChannelId[] {
  return (Object.keys(CHANNEL_CONFIG_TABLE) as ConfiguredChannelId[]).filter((id) => {
    if (SUB_SWITCHES.includes(id)) return false;
    const ref = CHANNEL_CONFIG_TABLE[id];
    const block = ref.section === "linkedin" ? config.linkedin[ref.key] : config.sources[ref.key];
    return !isOtherMarket(block.markets);
  });
}

/** Whether a channel's own switch is on (before the market filter). */
export function channelSwitch(config: ChannelsConfig, id: ConfiguredChannelId): boolean {
  const ref = CHANNEL_CONFIG_TABLE[id];
  return (ref.section === "linkedin" ? config.linkedin[ref.key] : config.sources[ref.key]).enabled;
}

function registryProblem(state: RegistryActionState): SetupFormError | "needsParent" | null {
  if (state.status === "done") return null;
  switch (state.error) {
    case "no_changes":
      return null;
    case "config_invalid":
      return "configUnreadable";
    case "needs_parent":
      return "needsParent";
    case "invalid":
    case "unknown_entry":
      return "invalidPayload";
    default:
      return "writeFailed";
  }
}

const sameBoard = (a: { ats: string; token: string }, b: { ats: string; token: string }): boolean => a.ats === b.ats && a.token.toLowerCase() === b.token.toLowerCase();

export async function saveSourcesStep(raw: unknown): Promise<SetupStepResult> {
  const frozen = setupFrozen("sources");
  if (frozen) return frozen;
  const parsed = sourcesInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("sources", "invalidPayload");
  const config = readFresh("channels");
  if (config === null) return stepError("sources", "configUnreadable");

  const offered = new Set<string>(offeredChannelIds(config));
  const errors: SetupFieldError[] = [];
  for (const id of Object.keys(parsed.data.channels)) {
    if (!isConfiguredChannelId(id) || !offered.has(id)) errors.push({ path: `channels.${id}`, ns: "setup", key: "invalidChoice" });
  }

  const boards = parsed.data.boards.map((board) => ({ name: board.name.trim(), ats: board.ats.trim(), token: board.token.trim() }));
  const seen: Array<{ ats: string; token: string }> = [...config.ats_boards];
  boards.forEach((board, index) => {
    const entry = atsBoardEntrySchema.safeParse({ ...board, enabled: true });
    if (!entry.success) {
      for (const issue of entry.error.issues) {
        const field = String(issue.path[0] ?? "token");
        const key = field === "ats" ? "invalidChoice" : board[field as "name" | "token"] === "" ? "required" : "boardInvalid";
        errors.push({ path: `boards.${index}.${field}`, ns: "setup", key, ...(key === "boardInvalid" ? { params: { message: issue.message } } : {}) });
      }
      return;
    }
    if (seen.some((other) => sameBoard(other, board))) errors.push({ path: `boards.${index}.token`, ns: "setup", key: "boardDuplicate" });
    seen.push(board);
  });
  // Switching on a channel that needs the terms-of-service acknowledgement (scraping, account automation) needs it given. A
  // channel that is already on in a step saved before is not asked again; before the step was first saved every switch counts.
  const stepSaved = readSetupState().state?.steps?.sources?.status === "done";
  const needsAcknowledge = Object.entries(parsed.data.channels).some(
    ([id, enabled]) => enabled && isConfiguredChannelId(id) && consentKind(id) !== null && (!stepSaved || !channelSwitch(config, id)),
  );
  if (needsAcknowledge && !parsed.data.acknowledge) errors.push({ path: "acknowledge", ns: "setup", key: "consentRequired" });
  if (errors.length > 0) return stepError("sources", null, errors);

  for (const [id, enabled] of Object.entries(parsed.data.channels)) {
    if (!isConfiguredChannelId(id) || channelSwitch(config, id) === enabled) continue;
    const problem = registryProblem(await setSourceEnabled({ id, enabled, ...(enabled && consentKind(id) !== null ? { acknowledged: true } : {}) }));
    if (problem === "needsParent") return stepError("sources", null, [{ path: `channels.${id}`, ns: "setup", key: "needsParent" }]);
    if (problem !== null) return stepError("sources", problem);
  }
  for (const [index, board] of boards.entries()) {
    const ats = ATS_KINDS.find((kind) => kind === board.ats);
    if (ats === undefined) return stepError("sources", null, [{ path: `boards.${index}.ats`, ns: "setup", key: "invalidChoice" }]);
    const problem = registryProblem(await saveAtsBoard({ original: null, board: { name: board.name, ats, token: board.token, enabled: true } }));
    if (problem === "needsParent") return stepError("sources", "writeFailed");
    if (problem !== null) return stepError("sources", problem);
  }
  return finishStep("sources");
}
