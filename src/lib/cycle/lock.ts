// The cycle API stays here; connection ownership and all SQL belong to the database layer.
export { findCycleLockHolder, withCycleLock, type CycleLockHolder, type LockResult } from "@/lib/db/cycle-lock";
