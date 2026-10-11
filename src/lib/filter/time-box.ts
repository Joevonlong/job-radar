/**
 * The server's time box for user patterns (`TimeBox` of the deal-breakers): node:vm interrupts a script that runs longer than
 * its timeout, also inside a regular expression, which a timer cannot. The work is a function of this process called from a
 * tiny script in a separate context; only the time limit comes from vm. Server code only (node:vm): the filter step, the
 * previews and the job page call it, the pure rule code takes it as a parameter.
 */
import vm from "node:vm";

import type { TimeBox } from "./deal-breakers";

const sandbox: { work: (() => void) | null } = { work: null };
const context = vm.createContext(sandbox);
const script = new vm.Script("work()");

/** Run `work`, stop it after `ms` milliseconds (at least 1): true when it finished. Errors other than the timeout are thrown. */
export const vmTimeBox: TimeBox = (work, ms) => {
  if (!(ms > 0)) return false;
  // a box inside a box would let the inner timeout end the outer one's work: run the inner work directly instead
  if (sandbox.work !== null) {
    work();
    return true;
  }
  sandbox.work = work;
  try {
    script.runInContext(context, { timeout: Math.max(1, Math.ceil(ms)) });
    return true;
  } catch (error) {
    // not `instanceof Error`: the timeout error may come from another realm (a test runner's, for one)
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return false;
    throw error;
  } finally {
    sandbox.work = null;
  }
};
