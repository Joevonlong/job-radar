import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";

/** A database handle or an open transaction: repos accept either so callers can compose them. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
