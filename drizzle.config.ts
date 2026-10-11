import { defineConfig } from "drizzle-kit";

// DATABASE_URL falls back to the host-side address of the compose `db` service
// (127.0.0.1:5433, see compose.yaml) so `pnpm db:migrate` works out of the box locally.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://jobradar:jobradar@127.0.0.1:5433/jobradar",
  },
});
