import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const overrideUrl = process.env.OVERRIDE_DATABASE_URL;
const connectionString = overrideUrl ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}
const dbHostHint = connectionString.replace(/.*@/, "").split("/")[0]?.split(".")[0] ?? "unknown";
console.log(`[db] using ${overrideUrl ? "OVERRIDE_DATABASE_URL" : "DATABASE_URL"} (host=${dbHostHint})`);

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export * from "./schema";
export { seedPolicies, DEFAULT_POLICY_SLUGS, backfillEmployeeProfileFields } from "./seed";
