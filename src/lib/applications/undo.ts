import { z } from "zod";

import { AgentWriteError, valueFingerprint, type UndoKind, type UndoRegistry } from "@/lib/agent-access/write";
import { latestApplicationEventId, readApplicationForUndo } from "@/lib/db/repos/application-undo";
import { APPLICATION_STATUSES } from "@/lib/db/repos/applications";

import { changeApplicationStatus, setInterviewRounds, setNextAction } from "./service";

const nextActionValue = z.strictObject({ nextAction: z.string().nullable(), nextActionAt: z.iso.datetime().nullable() });

const status: UndoKind = {
  area: "tracking",
  field: "application_status",
  async read(tx, target) {
    const app = await readApplicationForUndo(tx, target.id);
    const event = app ? await latestApplicationEventId(tx, app.id) : null;
    return { value: app?.status ?? "new", fingerprint: valueFingerprint({ id: app?.id ?? null, status: app?.status ?? null, at: app?.statusChangedAt ?? null, event }) };
  },
  async restore(tx, target, value, caller) {
    const result = await changeApplicationStatus(tx, { jobId: target.id, status: z.enum(APPLICATION_STATUSES).parse(value) }, caller);
    if (!result.ok) throw new AgentWriteError("conflict");
    return { research: result.research };
  },
};
const nextAction: UndoKind = {
  area: "tracking",
  field: "next_action",
  async read(tx, target) {
    const app = await readApplicationForUndo(tx, target.id);
    const value = app ? { nextAction: app.nextAction, nextActionAt: app.nextActionAt?.toISOString() ?? null } : null;
    return { value, fingerprint: valueFingerprint({ id: app?.id ?? null, value }) };
  },
  async restore(tx, target, value, caller) {
    const before = nextActionValue.parse(value);
    if (!(await setNextAction(tx, { jobId: target.id, nextAction: before.nextAction, nextActionAt: before.nextActionAt ? new Date(before.nextActionAt) : null }, caller))) throw new AgentWriteError("conflict");
  },
};
const interviewRounds: UndoKind = {
  area: "tracking",
  field: "interview_rounds",
  async read(tx, target) {
    const app = await readApplicationForUndo(tx, target.id);
    return { value: app?.interviewRounds ?? null, fingerprint: valueFingerprint({ id: app?.id ?? null, rounds: app?.interviewRounds ?? null }) };
  },
  async restore(tx, target, value, caller) {
    if (await setInterviewRounds(tx, { jobId: target.id, rounds: z.number().int().nonnegative().parse(value) }, caller) === null) throw new AgentWriteError("conflict");
  },
};

export const applicationUndoKinds: UndoRegistry = new Map([
  ["application_status", status],
  ["next_action", nextAction],
  ["interview_rounds", interviewRounds],
]);
