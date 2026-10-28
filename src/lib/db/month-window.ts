import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Indexable UTC envelope plus exact local bounds, including skipped/repeated midnight at a month boundary. */
export function calendarMonthSql(column: AnyPgColumn, args: { month: string; timeZone: string }): SQL {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) return sql`false`;
  const first = `${args.month}-01`;
  // A repeated midnight can straddle two months (even making membership non-contiguous). Keep a day's UTC margin
  // around each resolved boundary, then check local timestamps only for the index-selected month-sized slice.
  return sql`${column} >= ((${first}::timestamp at time zone ${args.timeZone}) - interval '24 hours')
    and ${column} < (((${first}::timestamp + interval '1 month') at time zone ${args.timeZone}) + interval '24 hours')
    and (${column} at time zone ${args.timeZone}) >= ${first}::timestamp
    and (${column} at time zone ${args.timeZone}) < (${first}::timestamp + interval '1 month')`;
}
